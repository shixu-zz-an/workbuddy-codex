# Risks

## Token Proxy Mode

Token proxy mode can be useful when app-server mode is unavailable, but it is intentionally not the default.

Risks:

- Upstream private APIs can change without notice.
- Reusing product login tokens outside their intended client may violate provider terms.
- Tokens can grant broad account access if leaked.
- Some upstreams may rate limit, suspend, or reject unsupported clients.
- Streaming proxy mode forwards upstream SSE payloads directly, so upstream protocol quirks are exposed to WorkBuddy unchanged.

Project safeguards:

- Token proxy mode is disabled by default.
- The dashboard requires explicit risk acceptance.
- Token values are not printed by `doctor` or `/api/status`.
- Env var token loading is preferred over storing token values in config.
- Upstream SSE is only streamed when the upstream marks it as `text/event-stream`; non-SSE responses are still buffered for normal error handling.

## WorkBuddy Compatibility

The normal bridge depends on WorkBuddy sending OpenAI-compatible `messages` and `tools`. If WorkBuddy uses a non-standard custom protocol for some features, those features may need additional adapters.

The model metadata is intentionally honest. Image and reasoning-output flags are not enabled by default because the bridge cannot yet faithfully deliver those capabilities. Enabling them prematurely would cause WorkBuddy to send richer inputs or UI expectations that Codex app-server mode does not currently satisfy.

Usage numbers returned by the bridge are estimates. They exist so WorkBuddy does not see empty token accounting, but they must not be treated as billing-grade provider usage.

## Codex Compatibility

`codex app-server` is currently marked experimental by the Codex CLI. The project isolates the JSON-RPC bridge in `src/app-server/` so protocol changes are localized.
