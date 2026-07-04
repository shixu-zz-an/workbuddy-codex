import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".workbuddy-codex");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const DEFAULT_CONFIG = {
  mode: "app-server",
  server: {
    host: "127.0.0.1",
    port: 8787,
    authToken: "",
  },
  logging: {
    requestLogFile: "logs/requests.log",
  },
  workbuddy: {
    configDir: path.join(os.homedir(), ".workbuddy"),
    installAppServerModel: true,
    installTokenProxyModel: true,
  },
  codex: {
    bin: "codex",
    cwd: process.cwd(),
    model: "",
    effort: "low",
    sandbox: "read-only",
    approvalPolicy: "never",
    requestTimeoutMs: 300000,
    appServerArgs: [],
  },
  tokenProxy: {
    enabled: false,
    riskAccepted: false,
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "",
    authSource: "env",
    bearerToken: "",
    bearerTokenEnv: "WORKBUDDY_CODEX_BEARER_TOKEN",
    headers: {},
    timeoutMs: 300000,
  },
};

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(overrides = {}, base = DEFAULT_CONFIG) {
  if (!isPlainObject(overrides)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(value, result[key]);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function readConfig(file = CONFIG_FILE) {
  try {
    const raw = await readFile(file, "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return mergeConfig();
    throw error;
  }
}

export async function writeConfig(config, file = CONFIG_FILE) {
  await mkdir(path.dirname(file), { recursive: true });
  const merged = mergeConfig(config);
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export function sanitizeConfigForDisplay(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeConfigForDisplay(item));
  if (!isPlainObject(value)) return value;

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && /(token|secret|apikey|api_key|authorization|password)/i.test(key) && nested) {
      result[key] = "********";
    } else {
      result[key] = sanitizeConfigForDisplay(nested);
    }
  }
  return result;
}

export function endpointFor(config) {
  return `http://${config.server.host}:${config.server.port}/v1/chat/completions`;
}
