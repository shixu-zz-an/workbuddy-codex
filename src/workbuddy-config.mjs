import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function modelEntry({ endpoint, modelId, modelName, supportsToolCall = true, apiKey = "local" }) {
  return {
    id: modelId,
    name: modelName,
    vendor: "OpenAI",
    url: endpoint,
    apiKey,
    supportsToolCall,
    supportsImages: false,
    supportsReasoning: false,
    onlyReasoning: false,
    maxInputTokens: 200000,
    maxOutputTokens: 12000,
  };
}

export async function installWorkBuddyModel({
  configDir = path.join(os.homedir(), ".workbuddy"),
  endpoint,
  modelId = "codex-app-server",
  modelName = "Codex App Server Bridge",
  supportsToolCall = true,
  apiKey = "local",
} = {}) {
  if (!endpoint) throw new Error("endpoint is required");
  await mkdir(configDir, { recursive: true });
  const file = path.join(configDir, "models.json");

  let models = [];
  try {
    const raw = await readFile(file, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    models = Array.isArray(parsed) ? parsed : Array.isArray(parsed.models) ? parsed.models : [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(file, `${file}.backup-${stamp}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const next = modelEntry({ endpoint, modelId, modelName, supportsToolCall, apiKey });
  models = models.filter((model) => model?.id !== modelId);
  models.push(next);
  await writeFile(file, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  return { file, model: next, count: models.length };
}

export async function installDefaultWorkBuddyModels({ config, endpoint }) {
  const results = [];
  if (config.workbuddy?.installAppServerModel !== false) {
    results.push(
      await installWorkBuddyModel({
        configDir: config.workbuddy?.configDir,
        endpoint,
        modelId: "codex-app-server",
        modelName: "Codex App Server Bridge",
        supportsToolCall: true,
        apiKey: config.server?.authToken || "local",
      }),
    );
  }
  if (config.workbuddy?.installTokenProxyModel !== false) {
    results.push(
      await installWorkBuddyModel({
        configDir: config.workbuddy?.configDir,
        endpoint,
        modelId: "codex-token-proxy",
        modelName: "Codex Token Proxy (Emergency)",
        supportsToolCall: true,
        apiKey: config.server?.authToken || "local",
      }),
    );
  }
  return results;
}
