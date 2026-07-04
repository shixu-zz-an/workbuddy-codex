import http from "node:http";
import { randomUUID } from "node:crypto";
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
import { RequestLog } from "./request-log.mjs";
import { dashboardHtml } from "./ui/dashboard.mjs";
import { installDefaultWorkBuddyModels } from "./workbuddy-config.mjs";

export class GatewayServer {
  constructor({ config, configFile, logger = console } = {}) {
    this.config = mergeConfig(config || {});
    this.configFile = configFile;
    this.logger = logger;
    this.requestLog = new RequestLog({ file: this.config.logging?.requestLogFile, logger });
    this.appServerProvider = new AppServerProvider({ config: this.config, logger });
    this.tokenProxyProvider = new TokenProxyProvider({
      config: this.config,
      appServerClient: this.appServerProvider.client,
    });
    this.httpServer = http.createServer((req, res) => {
      const requestContext = this.#requestContext(req);
      this.#logRequest("request_start", requestContext, {
        method: req.method,
        path: requestContext.path,
        query: requestContext.query,
        userAgent: req.headers["user-agent"] || "",
      });
      this.#route(req, res, requestContext).catch((error) => this.#sendError(res, error, requestContext));
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
        this.httpServer.close((error) => {
          if (error) return reject(error);
          this.requestLog.flush().then(resolve, reject);
        });
      });
    });
  }

  async #route(req, res, requestContext) {
    try {
      if (req.method === "GET" && req.url === "/") return this.#html(res, dashboardHtml(this.config), requestContext);
      if (req.method === "GET" && req.url === "/health") return this.#json(res, 200, { ok: true }, {}, requestContext);
      if (req.method === "GET" && req.url === "/api/status") return this.#json(res, 200, this.#status(), {}, requestContext);
      if (req.method === "GET" && req.url === "/api/config") {
        return this.#json(res, 200, sanitizeConfigForDisplay(this.config), {}, requestContext);
      }
      if (req.method === "POST" && req.url === "/api/config") return this.#updateConfig(req, res, requestContext);
      if (req.method === "POST" && req.url === "/api/install-workbuddy") return this.#installWorkBuddy(res, requestContext);
      if (req.method === "GET" && req.url === "/v1/models") return this.#models(res, requestContext);
      if (req.method === "POST" && req.url === "/v1/chat/completions") return this.#chat(req, res, requestContext);
      return this.#json(res, 404, openAiError(404, "not found").body, {}, requestContext);
    } catch (error) {
      return this.#sendError(res, error, requestContext);
    }
  }

  #sendError(res, error, requestContext) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const details = error instanceof HttpError ? error.details : error?.message || String(error);
    this.#logRequest("request_error", requestContext, {
      statusCode,
      error: error?.message || String(error),
    });
    return this.#json(res, statusCode, openAiError(statusCode, error.message, details).body, {}, requestContext);
  }

  async #updateConfig(req, res, requestContext) {
    const patch = await this.#readJson(req, requestContext);
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
    this.requestLog = new RequestLog({ file: this.config.logging?.requestLogFile, logger: this.logger });
    if (this.configFile) await writeConfig(this.config, this.configFile);
    return this.#json(res, 200, sanitizeConfigForDisplay(this.config), {}, requestContext);
  }

  async #installWorkBuddy(res, requestContext) {
    const results = await installDefaultWorkBuddyModels({
      config: this.config,
      endpoint: endpointFor(this.config),
    });
    return this.#json(res, 200, { ok: true, results }, {}, requestContext);
  }

  #models(res, requestContext) {
    return this.#json(res, 200, {
      object: "list",
      data: [
        { id: "codex-app-server", object: "model", created: 0, owned_by: "local" },
        { id: "codex-token-proxy", object: "model", created: 0, owned_by: "local" },
      ],
    }, {}, requestContext);
  }

  async #chat(req, res, requestContext) {
    this.#requireAuth(req);
    const body = await this.#readJson(req, requestContext);
    const provider = this.#selectProvider(body);
    this.#logRequest("provider_selected", requestContext, {
      provider: provider === this.tokenProxyProvider ? "token-proxy" : "app-server",
      model: body.model || "",
      stream: Boolean(body.stream),
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
    const result = await provider.complete(body);
    this.#logRequest("provider_result", requestContext, {
      resultType: result.type,
      statusCode: result.statusCode || 200,
      contentLength: typeof result.content === "string" ? result.content.length : undefined,
      toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : undefined,
    });

    if (result.type === "raw") {
      return this.#json(res, result.statusCode || 200, result.body, result.headers, requestContext);
    }
    if (result.type === "tool_calls") {
      return this.#json(res, 200, buildToolCallCompletion(body, result.toolCalls), {}, requestContext);
    }
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of buildSseChunks(body, result.content || "")) res.write(chunk);
      this.#logRequest("response_sent", requestContext, { statusCode: 200, streaming: true });
      return res.end();
    }
    return this.#json(res, 200, buildChatCompletion(body, result.content || ""), {}, requestContext);
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

  #html(res, body, requestContext = undefined) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    this.#logRequest("response_sent", requestContext, {
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      contentLength: Buffer.byteLength(body),
    });
    res.end(body);
  }

  #json(res, statusCode, body, headers = {}, requestContext = undefined) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      ...headers,
    });
    this.#logRequest("response_sent", requestContext, {
      statusCode,
      contentType: headers["content-type"] || "application/json; charset=utf-8",
      contentLength: Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  async #readJson(req, requestContext) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    this.#logRequest("request_body", requestContext, {
      byteLength: Buffer.byteLength(raw),
      body: this.#redact(body),
    });
    return body;
  }

  #requestContext(req) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    return {
      requestId: randomUUID(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      startedAt: Date.now(),
    };
  }

  #logRequest(event, requestContext, fields = {}) {
    if (!requestContext) return;
    this.requestLog.write(event, {
      requestId: requestContext.requestId,
      elapsedMs: Date.now() - requestContext.startedAt,
      ...fields,
    });
  }

  #redact(value) {
    if (Array.isArray(value)) return value.map((item) => this.#redact(item));
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/(token|secret|apikey|api_key|authorization|password|bearer)/i.test(key)) {
        result[key] = nested ? "********" : nested;
      } else {
        result[key] = this.#redact(nested);
      }
    }
    return result;
  }
}

export async function startGateway({ config, configFile, logger } = {}) {
  const gateway = new GatewayServer({ config, configFile, logger });
  await gateway.listen();
  return gateway;
}
