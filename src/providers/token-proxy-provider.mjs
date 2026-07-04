import { HttpError, stripWorkBuddyModelPrefix } from "../http/openai-compatible.mjs";

export class TokenProxyProvider {
  constructor({ config, fetchImpl = globalThis.fetch, appServerClient = null } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.appServerClient = appServerClient;
  }

  async complete(requestBody) {
    const tokenProxy = this.config.tokenProxy || {};
    if (!tokenProxy.enabled) {
      throw new HttpError(400, "Token proxy mode is disabled.");
    }
    if (!tokenProxy.riskAccepted) {
      throw new HttpError(403, "Token proxy mode requires explicit risk acceptance.");
    }
    if (!tokenProxy.endpoint) {
      throw new HttpError(400, "Token proxy endpoint is not configured.");
    }

    const bearerToken = await this.#resolveBearerToken(tokenProxy);
    const headers = {
      "content-type": "application/json",
      ...(tokenProxy.headers || {}),
    };
    if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

    const upstreamBody = {
      ...requestBody,
      model: tokenProxy.model || stripWorkBuddyModelPrefix(requestBody.model),
    };

    const response = await this.fetchImpl(tokenProxy.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(tokenProxy.timeoutMs || 300000),
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new HttpError(response.status, "Token proxy upstream request failed.", body);
    }

    return {
      type: "raw",
      statusCode: response.status,
      body,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      },
    };
  }

  async #resolveBearerToken(tokenProxy) {
    if (tokenProxy.bearerToken) return tokenProxy.bearerToken;
    if (tokenProxy.authSource === "env") return process.env[tokenProxy.bearerTokenEnv || "WORKBUDDY_CODEX_BEARER_TOKEN"] || "";
    if (tokenProxy.authSource === "codex-app-server") {
      if (!this.appServerClient) throw new HttpError(400, "Codex app-server token source is unavailable.");
      await this.appServerClient.start();
      const status = await this.appServerClient.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      });
      return status.authToken || "";
    }
    return "";
  }
}
