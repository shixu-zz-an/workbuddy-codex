import { createHash } from "node:crypto";
import { CodexAppServerClient } from "../app-server/codex-app-server-client.mjs";
import { createDeferred, withTimeout } from "../deferred.mjs";
import {
  extractToolResults,
  messagesToPrompt,
  normalizeContent,
  normalizeOpenAiTools,
  resolveReasoningEffort,
} from "../http/openai-compatible.mjs";

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

function sandboxForCodex(value) {
  if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") return value;
  return "read-only";
}

function approvalForCodex(value) {
  if (value === "never" || value === "on-request" || value === "untrusted" || value === "on-failure") return value;
  return "never";
}

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  let failure;

  function settle() {
    while (waiters.length && (values.length || closed || failure)) {
      const waiter = waiters.shift();
      if (failure) {
        waiter.reject(failure);
      } else if (values.length) {
        waiter.resolve({ value: values.shift(), done: false });
      } else {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }

  return {
    push(value) {
      if (closed || failure) return;
      values.push(value);
      settle();
    },
    close(value = undefined) {
      if (closed || failure) return;
      if (value !== undefined) values.push(value);
      closed = true;
      settle();
    },
    fail(error) {
      if (closed || failure) return;
      failure = error;
      settle();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (failure) return Promise.reject(failure);
            if (values.length) return Promise.resolve({ value: values.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
        };
      },
    },
  };
}

export class AppServerProvider {
  constructor({ client, config, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.client = client || new CodexAppServerClient({ config, logger });
    this.ready = false;
    this.activeByThread = new Map();
    this.pendingToolCalls = new Map();
  }

  async ensureReady() {
    if (this.ready) return;
    await this.client.start();
    this.client.onNotification((notification) => this.#handleNotification(notification));
    if (this.client.onRequest) this.client.onRequest((request) => this.#handleServerRequest(request));
    this.ready = true;
  }

  async complete(requestBody) {
    await this.ensureReady();
    const toolResults = extractToolResults(requestBody.messages || []);
    if (toolResults.length) {
      return this.#resumeWithToolResults(toolResults);
    }
    return this.#startTurn(requestBody);
  }

  async completeStream(requestBody) {
    await this.ensureReady();
    const toolResults = extractToolResults(requestBody.messages || []);
    if (toolResults.length) {
      return this.#resumeStreamWithToolResults(toolResults);
    }
    return this.#startStreamTurn(requestBody);
  }

  async #startTurn(requestBody) {
    const codex = this.config.codex || {};
    const effort = resolveReasoningEffort(requestBody, codex.effort || "low");
    const dynamicTools = normalizeOpenAiTools(requestBody.tools || []);
    const threadResponse = await this.client.request("thread/start", {
      cwd: codex.cwd || process.cwd(),
      model: codex.model || null,
      approvalPolicy: approvalForCodex(codex.approvalPolicy),
      sandbox: sandboxForCodex(codex.sandbox),
      ephemeral: true,
      threadSource: "workbuddy-codex",
      dynamicTools,
      config: effort ? { model_reasoning_effort: effort } : null,
    });

    const threadId = threadResponse.thread.id;
    const active = {
      threadId,
      turnId: null,
      content: "",
      completed: createDeferred(),
      toolRequested: createDeferred(),
      toolRequestedResolved: false,
      toolRequestedScheduled: false,
      toolCalls: [],
      toolHash: stableHash(dynamicTools),
      stream: null,
      streamTimeout: null,
    };
    this.activeByThread.set(threadId, active);

    const turnResponse = await this.client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: messagesToPrompt(requestBody), text_elements: [] }],
      effort,
      model: codex.model || null,
    });
    active.turnId = turnResponse.turn.id;

    try {
      return await withTimeout(
        Promise.race([active.completed.promise, active.toolRequested.promise]),
        codex.requestTimeoutMs || 300000,
        "Timed out waiting for Codex app-server response",
      );
    } catch (error) {
      await this.#interruptActive(active);
      this.activeByThread.delete(threadId);
      throw error;
    }
  }

  async #startStreamTurn(requestBody) {
    const codex = this.config.codex || {};
    const effort = resolveReasoningEffort(requestBody, codex.effort || "low");
    const dynamicTools = normalizeOpenAiTools(requestBody.tools || []);
    const threadResponse = await this.client.request("thread/start", {
      cwd: codex.cwd || process.cwd(),
      model: codex.model || null,
      approvalPolicy: approvalForCodex(codex.approvalPolicy),
      sandbox: sandboxForCodex(codex.sandbox),
      ephemeral: true,
      threadSource: "workbuddy-codex",
      dynamicTools,
      config: effort ? { model_reasoning_effort: effort } : null,
    });

    const threadId = threadResponse.thread.id;
    const active = {
      threadId,
      turnId: null,
      content: "",
      completed: createDeferred(),
      toolRequested: createDeferred(),
      toolRequestedResolved: false,
      toolRequestedScheduled: false,
      toolCalls: [],
      toolHash: stableHash(dynamicTools),
      stream: createAsyncQueue(),
      streamTimeout: null,
    };
    this.activeByThread.set(threadId, active);

    const turnResponse = await this.client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: messagesToPrompt(requestBody), text_elements: [] }],
      effort,
      model: codex.model || null,
    });
    active.turnId = turnResponse.turn.id;
    this.#armStreamTimeout(active);
    return this.#streamResult(active);
  }

  async #resumeStreamWithToolResults(toolResults) {
    const touchedThreads = new Set();
    for (const result of toolResults) {
      const pending = this.pendingToolCalls.get(result.toolCallId);
      if (!pending) continue;
      this.pendingToolCalls.delete(result.toolCallId);
      touchedThreads.add(pending.threadId);
      pending.deferred.resolve({
        contentItems: [{ type: "inputText", text: result.content }],
        success: true,
      });
    }

    const threadId = touchedThreads.values().next().value;
    const active = threadId ? this.activeByThread.get(threadId) : null;
    if (!active) {
      return {
        type: "message_stream",
        deltas: (async function* () {
          yield "No pending Codex tool call matched the WorkBuddy tool result.";
        })(),
        cancel: async () => {},
      };
    }

    active.stream = createAsyncQueue();
    active.streamTimeout = null;
    this.#armStreamTimeout(active);
    return this.#streamResult(active);
  }

  async #resumeWithToolResults(toolResults) {
    const touchedThreads = new Set();
    for (const result of toolResults) {
      const pending = this.pendingToolCalls.get(result.toolCallId);
      if (!pending) continue;
      this.pendingToolCalls.delete(result.toolCallId);
      touchedThreads.add(pending.threadId);
      pending.deferred.resolve({
        contentItems: [{ type: "inputText", text: result.content }],
        success: true,
      });
    }

    if (!touchedThreads.size) {
      return {
        type: "message",
        content: "No pending Codex tool call matched the WorkBuddy tool result.",
      };
    }

    const completions = [...touchedThreads].map((threadId) => {
      const active = this.activeByThread.get(threadId);
      return active?.completed.promise;
    }).filter(Boolean);

    try {
      return await withTimeout(
        Promise.race(completions),
        this.config.codex?.requestTimeoutMs || 300000,
        "Timed out waiting for Codex after WorkBuddy tool result",
      );
    } catch (error) {
      for (const threadId of touchedThreads) {
        const active = this.activeByThread.get(threadId);
        if (active) {
          await this.#interruptActive(active);
          this.activeByThread.delete(threadId);
        }
      }
      throw error;
    }
  }

  #handleNotification(notification) {
    const params = notification.params || {};
    const active = this.activeByThread.get(params.threadId);
    if (!active) return;

    if (notification.method === "item/agentMessage/delta") {
      active.content += params.delta || "";
      this.#refreshStreamTimeout(active);
      active.stream?.push(params.delta || "");
      return;
    }

    if (notification.method === "item/completed" && params.item?.type === "agentMessage") {
      if (!active.content && params.item.text) active.content = params.item.text;
      this.#refreshStreamTimeout(active);
      return;
    }

    if (notification.method === "turn/completed") {
      const finalText = this.#extractFinalText(params.turn) || active.content;
      if (active.stream && !active.content && finalText) active.stream.push(finalText);
      active.stream?.close();
      if (active.streamTimeout) clearTimeout(active.streamTimeout);
      active.completed.resolve({ type: "message", content: finalText || "" });
      this.activeByThread.delete(params.threadId);
    }
  }

  #extractFinalText(turn) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const agentMessages = items.filter((item) => item.type === "agentMessage" && item.text);
    return agentMessages.at(-1)?.text || "";
  }

  #handleServerRequest(request) {
    if (request.method === "item/commandExecution/requestApproval") return { decision: "decline" };
    if (request.method === "item/fileChange/requestApproval") return { decision: "decline" };
    if (request.method === "item/permissions/requestApproval") {
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    }
    if (request.method === "execCommandApproval") return { decision: "denied" };
    if (request.method === "applyPatchApproval") return { decision: "denied" };
    if (request.method !== "item/tool/call") return undefined;
    const params = request.params || {};
    const active = this.activeByThread.get(params.threadId);
    const deferred = createDeferred();
    const toolCallId = params.callId;
    this.pendingToolCalls.set(toolCallId, {
      deferred,
      threadId: params.threadId,
      turnId: params.turnId,
      tool: params.tool,
    });

    if (active) {
      active.toolCalls.push({
        id: toolCallId,
        name: params.tool,
        arguments: params.arguments || {},
      });
      if (!active.toolRequestedScheduled && !active.toolRequestedResolved) {
        active.toolRequestedScheduled = true;
        queueMicrotask(() => {
          if (active.toolRequestedResolved) return;
          active.toolRequestedResolved = true;
          active.stream?.close({
            type: "tool_calls",
            toolCalls: active.toolCalls,
          });
          if (active.streamTimeout) clearTimeout(active.streamTimeout);
          active.toolRequested.resolve({
            type: "tool_calls",
            toolCalls: active.toolCalls,
          });
        });
      }
    }

    return deferred.promise;
  }

  async #interruptActive(active) {
    if (!active?.threadId || !active?.turnId) return;
    try {
      await this.client.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId,
      });
    } catch (error) {
      this.logger.warn?.(`failed to interrupt timed-out Codex turn: ${error?.message || error}`);
    }
  }

  #armStreamTimeout(active) {
    const timeoutMs = this.config.codex?.requestTimeoutMs || 300000;
    if (active.streamTimeout) clearTimeout(active.streamTimeout);
    active.streamTimeout = setTimeout(async () => {
      const error = new Error(`Timed out waiting for Codex app-server response after ${timeoutMs}ms without stream activity`);
      active.stream?.fail(error);
      await this.#interruptActive(active);
      this.activeByThread.delete(active.threadId);
    }, timeoutMs);
    active.streamTimeout.unref?.();
  }

  #refreshStreamTimeout(active) {
    if (!active?.stream || !active.streamTimeout) return;
    this.#armStreamTimeout(active);
  }

  #streamResult(active) {
    return {
      type: "message_stream",
      deltas: active.stream.iterable,
      cancel: async () => {
        if (active.streamTimeout) clearTimeout(active.streamTimeout);
        active.stream?.close();
        await this.#interruptActive(active);
        this.activeByThread.delete(active.threadId);
      },
    };
  }

  diagnostics() {
    return {
      provider: "app-server",
      ready: this.ready,
      pendingToolCalls: this.pendingToolCalls.size,
      activeThreads: this.activeByThread.size,
      client: this.client.diagnostics?.() || null,
    };
  }

  async stop() {
    await this.client.stop?.();
    this.ready = false;
    this.activeByThread.clear();
    this.pendingToolCalls.clear();
  }
}
