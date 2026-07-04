import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function modelEntry({
  endpoint,
  modelId,
  modelName,
  supportsToolCall = true,
  apiKey = "local",
  maxInputTokens = 200000,
  maxOutputTokens = 12000,
  supportsReasoning = false,
  supportsImages = false,
  descriptionZh,
  descriptionEn,
} = {}) {
  return {
    id: modelId,
    name: modelName,
    vendor: "OpenAI",
    url: endpoint,
    apiKey,
    tags: ["custom"],
    trustLevel: "custom",
    supportsToolCall,
    supportsImages,
    disabledMultimodal: !supportsImages,
    supportsReasoning,
    onlyReasoning: false,
    maxInputTokens,
    maxOutputTokens,
    maxAllowedSize: maxInputTokens,
    temperature: 1,
    credits: "local",
    descriptionZh: descriptionZh || "本地 Codex 网关模型，支持 WorkBuddy 工具调用和流式响应。",
    descriptionEn: descriptionEn || "Local Codex gateway model with WorkBuddy tool-call and streaming support.",
  };
}

export async function installWorkBuddyModel({
  configDir = path.join(os.homedir(), ".workbuddy"),
  endpoint,
  modelId = "codex-app-server",
  modelName = "Codex App Server Bridge",
  supportsToolCall = true,
  apiKey = "local",
  maxInputTokens = 200000,
  maxOutputTokens = 12000,
  supportsReasoning = false,
  supportsImages = false,
} = {}) {
  if (!endpoint) throw new Error("endpoint is required");
  await mkdir(configDir, { recursive: true });
  const file = path.join(configDir, "models.json");

  let models = [];
  let fileShape = "array";
  let originalObject = {};
  try {
    const raw = await readFile(file, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      models = parsed;
      fileShape = "array";
    } else if (parsed && typeof parsed === "object") {
      originalObject = parsed;
      models = Array.isArray(parsed.models) ? parsed.models : [];
      fileShape = "object";
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(file, `${file}.backup-${stamp}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const next = modelEntry({
    endpoint,
    modelId,
    modelName,
    supportsToolCall,
    apiKey,
    maxInputTokens,
    maxOutputTokens,
    supportsReasoning,
    supportsImages,
  });
  models = models.filter((model) => model?.id !== modelId);
  models.push(next);
  const output = fileShape === "object" ? { ...originalObject, models } : models;
  await writeFile(file, `${JSON.stringify(output, null, 2)}\n`, "utf8");
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
