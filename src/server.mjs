import http from "node:http";
import { AppServerProvider } from "./providers/app-server-provider.mjs";
import { TokenProxyProvider } from "./providers/token-proxy-provider.mjs";
import { endpointFor, mergeConfig, sanitizeConfigForDisplay, writeConfig } from "./config.mjs";
import {
  HttpError,
  buildChatCompletion,
  buildSseChunks,
  buildToolCallCompletion,
  openAiError,
  stripWorkBuddyModelPrefix,
} from "./http/openai-compatible.mjs";
import { dashboardHtml } from "./ui/dashboard.mjs";
import { installDefaultWorkBuddyModels } from "./workbuddy-config.mjs";

export class GatewayServer {
  constructor({ config, configFile, logger = console } = {}) {
    this.config = mergeConfig(config || {});
    this.configFile = configFile;
    this.logger = logger;
    this.appServerProvider = new AppServerProvider({ config: this.config, logger });
    this.tokenProxyProvider = new TokenProxyProvider({
      config: this.config,
      appServerClient: this.appServerProvider.client,
    });
    this.httpServer = http.createServer((req, res) => {
      this.#route(req, res).catch((error) => this.#sendError(res, error));
    });
  }

  listen() {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.server.port, this.config.server.host, () => resolve(this));
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.appServerProvider.stop?.().finally(() => {
        this.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }

  async #route(req, res) {
    try {
      if (req.method === "GET" && req.url === "/") return this.#html(res, dashboardHtml(this.config));
      if (req.method === "GET" && req.url === "/health") return this.#json(res, 200, { ok: true });
      if (req.method === "GET" && req.url === "/api/status") return this.#json(res, 200, this.#status());
      if (req.method === "GET" && req.url === "/api/config") {
        return this.#json(res, 200, sanitizeConfigForDisplay(this.config));
      }
      if (req.method === "POST" && req.url === "/api/config") return this.#updateConfig(req, res);
      if (req.method === "POST" && req.url === "/api/install-workbuddy") return this.#installWorkBuddy(res);
      if (req.method === "GET" && req.url === "/v1/models") return this.#models(res);
      if (req.method === "POST" && req.url === "/v1/chat/completions") return this.#chat(req, res);
      return this.#json(res, 404, openAiError(404, "not found").body);
    } catch (error) {
      return this.#sendError(res, error);
    }
  }

  #sendError(res, error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const details = error instanceof HttpError ? error.details : error?.message || String(error);
    return this.#json(res, statusCode, openAiError(statusCode, error.message, details).body);
  }

  async #updateConfig(req, res) {
    const patch = await this.#readJson(req);
    const shouldRebuildProviders = Boolean(patch.codex || patch.tokenProxy);
    if (shouldRebuildProviders) await this.appServerProvider.stop?.();
    this.config = mergeConfig(patch, this.config);
    if (shouldRebuildProviders) {
      this.appServerProvider = new AppServerProvider({ config: this.config, logger: this.logger });
      this.tokenProxyProvider = new TokenProxyProvider({
        config: this.config,
        appServerClient: this.appServerProvider.client,
      });
    } else {
      this.appServerProvider.config = this.config;
      this.tokenProxyProvider.config = this.config;
    }
    if (this.configFile) await writeConfig(this.config, this.configFile);
    return this.#json(res, 200, sanitizeConfigForDisplay(this.config));
  }

  async #installWorkBuddy(res) {
    const results = await installDefaultWorkBuddyModels({
      config: this.config,
      endpoint: endpointFor(this.config),
    });
    return this.#json(res, 200, { ok: true, results });
  }

  #models(res) {
    return this.#json(res, 200, {
      object: "list",
      data: [
        { id: "codex-app-server", object: "model", created: 0, owned_by: "local" },
        { id: "codex-token-proxy", object: "model", created: 0, owned_by: "local" },
      ],
    });
  }

  async #chat(req, res) {
    this.#requireAuth(req);
    const body = await this.#readJson(req);
    const provider = this.#selectProvider(body);
    const result = await provider.complete(body);

    if (result.type === "raw") {
      return this.#json(res, result.statusCode || 200, result.body, result.headers);
    }
    if (result.type === "tool_calls") {
      return this.#json(res, 200, buildToolCallCompletion(body, result.toolCalls));
    }
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of buildSseChunks(body, result.content || "")) res.write(chunk);
      return res.end();
    }
    return this.#json(res, 200, buildChatCompletion(body, result.content || ""));
  }

  #selectProvider(body) {
    const model = stripWorkBuddyModelPrefix(body.model);
    if (model === "codex-token-proxy" || this.config.mode === "token-proxy") return this.tokenProxyProvider;
    return this.appServerProvider;
  }

  #status() {
    return {
      ok: true,
      endpoint: endpointFor(this.config),
      config: sanitizeConfigForDisplay(this.config),
      appServer: this.appServerProvider.diagnostics(),
    };
  }

  #requireAuth(req) {
    const token = this.config.server?.authToken;
    if (!token) return;
    const header = req.headers.authorization || "";
    if (header === `Bearer ${token}` || header === token) return;
    throw new HttpError(401, "Unauthorized local gateway request.");
  }

  #html(res, body) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  #json(res, statusCode, body, headers = {}) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  async #readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }
}

export async function startGateway({ config, configFile, logger } = {}) {
  const gateway = new GatewayServer({ config, configFile, logger });
  await gateway.listen();
  return gateway;
}
