import assert from "node:assert/strict";
import test from "node:test";

import { AppServerProvider } from "../src/providers/app-server-provider.mjs";
import { TokenProxyProvider } from "../src/providers/token-proxy-provider.mjs";

async function collectAsync(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test("AppServerProvider starts a Codex turn and returns final assistant text", async () => {
  const calls = [];
  const fakeClient = {
    onNotification(handler) {
      this.handler = handler;
    },
    async start() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "initialize") return { userAgent: "test" };
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          this.handler({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "i1", delta: "hello" } });
          this.handler({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
        });
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };

  const provider = new AppServerProvider({
    client: fakeClient,
    config: { codex: { cwd: process.cwd(), effort: "low", sandbox: "read-only", approvalPolicy: "never" } },
  });

  const result = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.content, "hello");
  assert.equal(calls.some((call) => call.method === "thread/start"), true);
  assert.equal(calls.some((call) => call.method === "turn/start"), true);
});

test("AppServerProvider streams Codex deltas before turn completion", async () => {
  const fakeClient = {
    onNotification(handler) {
      this.handler = handler;
    },
    async start() {},
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-stream" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          this.handler({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-stream", turnId: "turn-stream", delta: "hel" },
          });
          this.handler({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-stream", turnId: "turn-stream", delta: "lo" },
          });
          this.handler({
            method: "turn/completed",
            params: { threadId: "thread-stream", turn: { id: "turn-stream", status: "completed" } },
          });
        });
        return { turn: { id: "turn-stream" } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const provider = new AppServerProvider({
    client: fakeClient,
    config: { codex: { cwd: process.cwd(), effort: "low", sandbox: "read-only", approvalPolicy: "never" } },
  });

  const result = await provider.completeStream({ messages: [{ role: "user", content: "hi" }], stream: true });

  assert.equal(result.type, "message_stream");
  assert.deepEqual(await collectAsync(result.deltas), ["hel", "lo"]);
});

test("AppServerProvider interrupts active streamed turn on cancellation", async () => {
  const calls = [];
  const fakeClient = {
    onNotification(handler) {
      this.handler = handler;
    },
    async start() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-cancel" } };
      if (method === "turn/start") return { turn: { id: "turn-cancel" } };
      if (method === "turn/interrupt") return {};
      throw new Error(`unexpected ${method}`);
    },
  };
  const provider = new AppServerProvider({
    client: fakeClient,
    logger: { warn() {} },
    config: { codex: { cwd: process.cwd(), effort: "low", sandbox: "read-only", approvalPolicy: "never" } },
  });

  const result = await provider.completeStream({ messages: [{ role: "user", content: "hi" }], stream: true });
  await result.cancel();

  assert.equal(provider.diagnostics().activeThreads, 0);
  assert.equal(calls.some((call) => call.method === "turn/interrupt"), true);
});

test("AppServerProvider bridges Codex dynamic tool calls back to OpenAI tool calls", async () => {
  const fakeClient = {
    onNotification(handler) {
      this.notificationHandler = handler;
    },
    onRequest(handler) {
      this.requestHandler = handler;
    },
    async start() {},
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-tool" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          const toolResultPromise = this.requestHandler({
            method: "item/tool/call",
            id: 100,
            params: {
              threadId: "thread-tool",
              turnId: "turn-tool",
              callId: "call-1",
              tool: "read_file",
              arguments: { path: "README.md" },
            },
          });
          toolResultPromise.then(() => {
            this.notificationHandler({
              method: "item/agentMessage/delta",
              params: { threadId: "thread-tool", turnId: "turn-tool", itemId: "i2", delta: "final answer" },
            });
            this.notificationHandler({
              method: "turn/completed",
              params: { threadId: "thread-tool", turn: { id: "turn-tool", status: "completed" } },
            });
          });
        });
        return { turn: { id: "turn-tool" } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };

  const provider = new AppServerProvider({
    client: fakeClient,
    config: { codex: { cwd: process.cwd(), effort: "low", sandbox: "read-only", approvalPolicy: "never" } },
  });

  const first = await provider.complete({
    messages: [{ role: "user", content: "read a file" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  });

  assert.equal(first.type, "tool_calls");
  assert.equal(first.toolCalls[0].id, "call-1");
  assert.equal(first.toolCalls[0].name, "read_file");

  const second = await provider.complete({
    messages: [{ role: "tool", tool_call_id: "call-1", content: "file text" }],
  });

  assert.equal(second.type, "message");
  assert.equal(second.content, "final answer");
});

test("TokenProxyProvider requires explicit risk acceptance", async () => {
  const provider = new TokenProxyProvider({
    config: { tokenProxy: { enabled: true, riskAccepted: false } },
    fetchImpl: async () => {
      throw new Error("must not call fetch");
    },
  });

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    /risk acceptance/,
  );
});

test("TokenProxyProvider returns upstream SSE as a raw stream without buffering", async () => {
  let abortSignal;
  const provider = new TokenProxyProvider({
    config: {
      tokenProxy: {
        enabled: true,
        riskAccepted: true,
        endpoint: "https://upstream.example/v1/chat/completions",
        bearerToken: "secret",
      },
    },
    fetchImpl: async (_url, init) => {
      abortSignal = init.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    },
  });

  const result = await provider.complete({ model: "codex-token-proxy", stream: true, messages: [] });

  assert.equal(result.type, "raw_stream");
  assert.equal(result.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(await new Response(result.body).text(), "data: first\n\ndata: [DONE]\n\n");
  await result.cancel();
  assert.equal(abortSignal.aborted, true);
});

test("AppServerProvider interrupts and clears active turn on timeout", async () => {
  const calls = [];
  const fakeClient = {
    onNotification(handler) {
      this.handler = handler;
    },
    onRequest() {},
    async start() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-timeout" } };
      if (method === "turn/start") return { turn: { id: "turn-timeout" } };
      if (method === "turn/interrupt") return {};
      throw new Error(`unexpected ${method}`);
    },
  };
  const provider = new AppServerProvider({
    client: fakeClient,
    logger: { warn() {} },
    config: { codex: { cwd: process.cwd(), effort: "low", sandbox: "read-only", approvalPolicy: "never", requestTimeoutMs: 1 } },
  });

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    /Timed out waiting for Codex app-server response/,
  );

  assert.equal(provider.diagnostics().activeThreads, 0);
  assert.equal(calls.some((call) => call.method === "turn/interrupt"), true);
});
