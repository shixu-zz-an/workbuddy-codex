import assert from "node:assert/strict";
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
