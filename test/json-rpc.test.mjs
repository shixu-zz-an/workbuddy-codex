import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { JsonRpcLineClient } from "../src/app-server/json-rpc-line-client.mjs";

test("JsonRpcLineClient resolves responses and emits notifications", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new JsonRpcLineClient({ input, output });
  const notifications = [];
  client.onNotification((notification) => notifications.push(notification));

  const promise = client.request("initialize", { ok: true });
  const written = JSON.parse(output.read().toString("utf8"));
  assert.equal(written.method, "initialize");

  input.write(JSON.stringify({ method: "thread/started", params: { threadId: "t1" } }) + "\n");
  input.write(JSON.stringify({ id: written.id, result: { ready: true } }) + "\n");

  assert.deepEqual(await promise, { ready: true });
  assert.deepEqual(notifications, [{ method: "thread/started", params: { threadId: "t1" } }]);
});

test("JsonRpcLineClient rejects JSON-RPC errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new JsonRpcLineClient({ input, output });

  const promise = client.request("bad", {});
  const written = JSON.parse(output.read().toString("utf8"));
  input.write(JSON.stringify({ id: written.id, error: { code: -1, message: "failed" } }) + "\n");

  await assert.rejects(promise, /failed/);
});

test("JsonRpcLineClient keeps reading while a server request waits for async result", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new JsonRpcLineClient({ input, output });
  const notifications = [];
  let resolveTool;

  client.onNotification((notification) => notifications.push(notification));
  client.onRequest((message) => {
    if (message.method !== "item/tool/call") return undefined;
    return new Promise((resolve) => {
      resolveTool = resolve;
    });
  });

  input.write(JSON.stringify({ id: 77, method: "item/tool/call", params: { tool: "read" } }) + "\n");
  input.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "still read" } }) + "\n");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, [{ method: "item/agentMessage/delta", params: { delta: "still read" } }]);

  resolveTool({ contentItems: [{ type: "inputText", text: "ok" }], success: true });
  await new Promise((resolve) => setImmediate(resolve));
  const response = JSON.parse(output.read().toString("utf8"));
  assert.equal(response.id, 77);
  assert.equal(response.result.success, true);
});
