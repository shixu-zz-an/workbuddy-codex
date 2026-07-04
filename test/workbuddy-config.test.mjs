import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installWorkBuddyModel } from "../src/workbuddy-config.mjs";

test("installWorkBuddyModel creates models.json with local gateway model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-config-"));

  const result = await installWorkBuddyModel({
    configDir: root,
    endpoint: "http://127.0.0.1:8787/v1/chat/completions",
    modelId: "codex-app-server",
    modelName: "Codex App Server",
    apiKey: "secret",
  });

  const models = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "codex-app-server");
  assert.equal(models[0].url, "http://127.0.0.1:8787/v1/chat/completions");
  assert.equal(models[0].apiKey, "secret");
  assert.equal(models[0].supportsToolCall, true);
  assert.deepEqual(models[0].tags, ["custom"]);
  assert.equal(models[0].trustLevel, "custom");
  assert.equal(models[0].supportsImages, false);
  assert.equal(models[0].disabledMultimodal, true);
  assert.equal(models[0].supportsReasoning, false);
  assert.equal(models[0].maxAllowedSize, models[0].maxInputTokens);
  assert.equal(typeof models[0].descriptionZh, "string");
  assert.equal(typeof models[0].descriptionEn, "string");
});

test("installWorkBuddyModel preserves unrelated existing models and replaces matching id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-config-"));
  const file = path.join(root, "models.json");
  await writeFile(
    file,
    JSON.stringify([
      { id: "other", name: "Other" },
      { id: "codex-app-server", name: "Old" },
    ]),
  );

  await installWorkBuddyModel({
    configDir: root,
    endpoint: "http://127.0.0.1:8787/v1/chat/completions",
    modelId: "codex-app-server",
    modelName: "Codex App Server",
  });

  const models = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(models.map((model) => model.id), ["other", "codex-app-server"]);
  assert.equal(models[1].name, "Codex App Server");
});

test("installWorkBuddyModel preserves object-shaped models.json files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-config-"));
  const file = path.join(root, "models.json");
  await writeFile(
    file,
    JSON.stringify({
      models: [{ id: "other", name: "Other" }],
      availableModels: [{ modelId: "default", name: "Default" }],
    }),
  );

  await installWorkBuddyModel({
    configDir: root,
    endpoint: "http://127.0.0.1:8787/v1/chat/completions",
    modelId: "codex-app-server",
    modelName: "Codex App Server",
  });

  const parsed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Array.isArray(parsed), false);
  assert.deepEqual(parsed.availableModels, [{ modelId: "default", name: "Default" }]);
  assert.deepEqual(parsed.models.map((model) => model.id), ["other", "codex-app-server"]);
});
