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
