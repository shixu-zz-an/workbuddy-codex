import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GatewayServer } from "../src/server.mjs";

test("GatewayServer returns JSON errors for async provider failures without crashing", async () => {
  const gateway = new GatewayServer({
    config: {
      server: { host: "127.0.0.1", port: 0 },
      mode: "app-server",
      tokenProxy: { enabled: false, riskAccepted: false },
    },
    logger: { warn() {} },
  });
  await gateway.listen();
  const { port } = gateway.httpServer.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-local:codex-token-proxy",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error.message, /Token proxy mode is disabled/);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await gateway.close();
  }
});

test("GatewayServer enforces local bearer auth when configured", async () => {
  const gateway = new GatewayServer({
    config: {
      server: { host: "127.0.0.1", port: 0, authToken: "local-secret" },
    },
    logger: { warn() {} },
  });
  await gateway.listen();
  const { port } = gateway.httpServer.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-app-server", messages: [] }),
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.match(body.error.message, /Unauthorized/);
  } finally {
    await gateway.close();
  }
});

test("GatewayServer writes request process events to a log file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "workbuddy-codex-log-"));
  const requestLogFile = path.join(tmpDir, "requests.log");
  const gateway = new GatewayServer({
    config: {
      server: { host: "127.0.0.1", port: 0 },
      logging: { requestLogFile },
    },
    logger: { warn() {} },
  });
  gateway.appServerProvider = {
    complete: async () => ({ type: "message", content: "logged" }),
    diagnostics: () => ({ provider: "test" }),
    stop: async () => {},
  };
  await gateway.listen();
  const { port } = gateway.httpServer.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer should-not-log" },
      body: JSON.stringify({
        model: "codex-app-server",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 200);
    await gateway.requestLog.flush();

    const lines = (await readFile(requestLogFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const events = lines.map((line) => line.event);
    assert.deepEqual(events, [
      "request_start",
      "request_body",
      "provider_selected",
      "provider_result",
      "response_sent",
    ]);
    assert.equal(new Set(lines.map((line) => line.requestId)).size, 1);
    assert.equal(lines[0].method, "POST");
    assert.equal(lines[0].path, "/v1/chat/completions");
    assert.equal(lines[1].body.model, "codex-app-server");
    assert.equal(lines[2].provider, "app-server");
    assert.equal(lines[3].resultType, "message");
    assert.equal(lines[4].statusCode, 200);
    assert.doesNotMatch(await readFile(requestLogFile, "utf8"), /should-not-log/);
  } finally {
    await gateway.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GatewayServer streams app-server deltas as OpenAI SSE chunks", async () => {
  const gateway = new GatewayServer({
    config: {
      server: { host: "127.0.0.1", port: 0 },
    },
    logger: { warn() {} },
  });
  gateway.appServerProvider = {
    completeStream: async () => ({
      type: "message_stream",
      deltas: (async function* () {
        yield "hel";
        yield "lo";
      })(),
      cancel: async () => {},
    }),
    diagnostics: () => ({ provider: "test" }),
    stop: async () => {},
  };
  await gateway.listen();
  const { port } = gateway.httpServer.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex-app-server",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(text, /"content":"hel"/);
    assert.match(text, /"content":"lo"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await gateway.close();
  }
});

test("GatewayServer forwards token-proxy SSE without JSON wrapping", async () => {
  const gateway = new GatewayServer({
    config: {
      server: { host: "127.0.0.1", port: 0 },
      mode: "token-proxy",
      tokenProxy: { enabled: true, riskAccepted: true, endpoint: "https://upstream.example/v1/chat/completions" },
    },
    logger: { warn() {} },
  });
  gateway.tokenProxyProvider = {
    complete: async () => ({
      type: "raw_stream",
      statusCode: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: upstream\n\n"));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      cancel: async () => {},
    }),
  };
  await gateway.listen();
  const { port } = gateway.httpServer.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex-token-proxy",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(text, "data: upstream\n\ndata: [DONE]\n\n");
  } finally {
    await gateway.close();
  }
});

test("GatewayServer returns tool calls as SSE when streaming is requested", async () => {
  const gateway = new GatewayServer({
    config: {
      server: { host: "127.0.0.1", port: 0 },
    },
    logger: { warn() {} },
  });
  gateway.appServerProvider = {
    complete: async () => ({
      type: "tool_calls",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
    }),
    diagnostics: () => ({ provider: "test" }),
    stop: async () => {},
  };
  await gateway.listen();
  const { port } = gateway.httpServer.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex-app-server",
        stream: true,
        messages: [{ role: "user", content: "read a file" }],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"name":"read_file"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await gateway.close();
  }
});
