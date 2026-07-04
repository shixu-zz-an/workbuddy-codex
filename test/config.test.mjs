import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, mergeConfig, sanitizeConfigForDisplay } from "../src/config.mjs";

test("mergeConfig preserves defaults while applying nested user overrides", () => {
  const config = mergeConfig({
    server: { port: 9999 },
    codex: { effort: "low" },
    tokenProxy: { enabled: true, bearerToken: "secret-token" },
  });

  assert.equal(config.server.host, DEFAULT_CONFIG.server.host);
  assert.equal(config.server.port, 9999);
  assert.equal(config.codex.effort, "low");
  assert.equal(config.codex.bin, DEFAULT_CONFIG.codex.bin);
  assert.equal(config.tokenProxy.enabled, true);
  assert.equal(config.tokenProxy.bearerToken, "secret-token");
});

test("sanitizeConfigForDisplay redacts token-like values", () => {
  const config = mergeConfig({
    tokenProxy: {
      enabled: true,
      bearerToken: "abc123",
      headers: {
        Authorization: "Bearer abc123",
        "x-safe": "visible",
      },
    },
  });

  const sanitized = sanitizeConfigForDisplay(config);
  assert.equal(sanitized.tokenProxy.bearerToken, "********");
  assert.equal(sanitized.tokenProxy.headers.Authorization, "********");
  assert.equal(sanitized.tokenProxy.headers["x-safe"], "visible");
});
