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
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), tokenProxy.timeoutMs || 300000);
    timeout.unref?.();

    let response;
    try {
      response = await this.fetchImpl(tokenProxy.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: abortController.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

    const contentType = response.headers.get("content-type") || "application/json; charset=utf-8";
    if (response.ok && response.body && /text\/event-stream/i.test(contentType)) {
      return {
        type: "raw_stream",
        statusCode: response.status,
        body: response.body,
        headers: {
          "content-type": contentType,
          "cache-control": response.headers.get("cache-control") || "no-cache",
        },
        cancel: async () => {
          clearTimeout(timeout);
          abortController.abort();
          const cancelled = response.body.cancel?.();
          await cancelled?.catch?.(() => {});
        },
        finalize: () => clearTimeout(timeout),
      };
    }

    let text;
    try {
      text = await response.text();
    } finally {
      clearTimeout(timeout);
    }
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
