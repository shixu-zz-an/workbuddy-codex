import { createHash } from "node:crypto";
import { CodexAppServerClient } from "../app-server/codex-app-server-client.mjs";
import { createDeferred, withTimeout } from "../deferred.mjs";
import {
  extractToolResults,
  messagesToPrompt,
  normalizeContent,
  normalizeOpenAiTools,
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

  async #startTurn(requestBody) {
    const codex = this.config.codex || {};
    const dynamicTools = normalizeOpenAiTools(requestBody.tools || []);
    const threadResponse = await this.client.request("thread/start", {
      cwd: codex.cwd || process.cwd(),
      model: codex.model || null,
      approvalPolicy: approvalForCodex(codex.approvalPolicy),
      sandbox: sandboxForCodex(codex.sandbox),
      ephemeral: true,
      threadSource: "workbuddy-codex",
      dynamicTools,
      config: codex.effort ? { model_reasoning_effort: codex.effort } : null,
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
    };
    this.activeByThread.set(threadId, active);

    const turnResponse = await this.client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: messagesToPrompt(requestBody), text_elements: [] }],
      effort: codex.effort || null,
      model: codex.model || null,
    });
    active.turnId = turnResponse.turn.id;

    const firstResult = await withTimeout(
      Promise.race([active.completed.promise, active.toolRequested.promise]),
      codex.requestTimeoutMs || 300000,
      "Timed out waiting for Codex app-server response",
    );

    return firstResult;
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

    return withTimeout(
      Promise.race(completions),
      this.config.codex?.requestTimeoutMs || 300000,
      "Timed out waiting for Codex after WorkBuddy tool result",
    );
  }

  #handleNotification(notification) {
    const params = notification.params || {};
    const active = this.activeByThread.get(params.threadId);
    if (!active) return;

    if (notification.method === "item/agentMessage/delta") {
      active.content += params.delta || "";
      return;
    }

    if (notification.method === "item/completed" && params.item?.type === "agentMessage") {
      if (!active.content && params.item.text) active.content = params.item.text;
      return;
    }

    if (notification.method === "turn/completed") {
      const finalText = this.#extractFinalText(params.turn) || active.content;
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
          active.toolRequested.resolve({
            type: "tool_calls",
            toolCalls: active.toolCalls,
          });
        });
      }
    }

    return deferred.promise;
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
