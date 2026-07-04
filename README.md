# workbuddy-codex

Local gateway that lets WorkBuddy use your authenticated Codex installation as an OpenAI-compatible custom model backend.

The default mode is safe and durable: WorkBuddy calls a localhost `/v1/chat/completions` endpoint, and the gateway talks to `codex app-server` over JSON-RPC. An emergency token-proxy mode is also available, but it is opt-in and risk-gated.

## Features

- OpenAI-compatible endpoint for WorkBuddy custom models.
- Normal mode: persistent `codex app-server` bridge, avoiding `codex exec` cold starts.
- True streaming: `stream: true` requests receive incremental OpenAI-compatible SSE chunks as Codex emits deltas.
- Tool-call bridge: WorkBuddy function tools are exposed to Codex as dynamic tools, then returned to WorkBuddy as OpenAI `tool_calls`.
- WorkBuddy-aware model metadata: installed models declare custom trust level, tool support, honest image/reasoning flags, and context limits.
- Structured transcript compiler: preserves roles, tool calls, tool results, content blocks, tool choice, and reasoning effort controls in the prompt sent to Codex.
- Emergency mode: forward requests to a configured token-proxy endpoint, including transparent upstream SSE forwarding.
- Local dashboard for switching modes and editing core settings.
- WorkBuddy config installer for `~/.workbuddy/models.json`.
- No runtime npm dependencies.

## Install

From this checkout:

```bash
cd /Volumes/ExtData/Documents/codes/workbuddy-codex
npm test
npm start
```

The gateway listens on:

```text
http://127.0.0.1:8787/v1/chat/completions
```

Dashboard:

```text
http://127.0.0.1:8787/
```

## Configure WorkBuddy

Run:

```bash
npm run install:workbuddy
```

This writes two custom model entries to `~/.workbuddy/models.json`:

- `codex-app-server` - normal mode, recommended.
- `codex-token-proxy` - emergency proxy mode.

Restart WorkBuddy if the model list does not refresh.

The installer preserves the existing `models.json` shape. It supports both root-array files and object-shaped files with `{ "models": [...] }`.

## Normal Mode

Normal mode uses:

```bash
codex app-server --stdio -c model_reasoning_effort="low"
```

Requests flow like this:

```text
WorkBuddy custom model
  -> localhost OpenAI-compatible endpoint
  -> workbuddy-codex
  -> codex app-server JSON-RPC
  -> your authenticated Codex backend
```

When WorkBuddy sends `stream: true`, the gateway returns `text/event-stream` immediately and forwards Codex app-server `item/agentMessage/delta` notifications as OpenAI-compatible `chat.completion.chunk` frames. The stream ends with a stop chunk and `data: [DONE]`.

The bridge intentionally does not advertise image or reasoning-output support by default. WorkBuddy will therefore keep image-only features away from this custom model instead of sending data the gateway cannot faithfully handle. Request-level reasoning effort is still mapped to Codex effort when WorkBuddy sends it.

Tool-call flow:

```text
WorkBuddy sends tools[]
  -> gateway maps them to Codex dynamicTools
  -> Codex asks item/tool/call
  -> gateway returns OpenAI tool_calls to WorkBuddy
  -> WorkBuddy runs its own tool
  -> WorkBuddy sends tool result
  -> gateway resolves the Codex dynamic tool call
  -> Codex returns final answer
```

## Emergency Token Proxy Mode

Emergency mode is disabled by default.

Enable it in the dashboard, or edit `~/.workbuddy-codex/config.json`:

```json
{
  "mode": "token-proxy",
  "tokenProxy": {
    "enabled": true,
    "riskAccepted": true,
    "endpoint": "https://example.local/v1/chat/completions",
    "authSource": "env",
    "bearerTokenEnv": "WORKBUDDY_CODEX_BEARER_TOKEN"
  }
}
```

Then start with:

```bash
WORKBUDDY_CODEX_BEARER_TOKEN="..." npm start
```

This mode exists for emergency fallback. It may be less stable and may carry account, product-policy, or provider-terms risk depending on the upstream endpoint and token source.

If the upstream returns `text/event-stream`, the gateway forwards the SSE body directly instead of buffering and reserializing it. If the client disconnects, the gateway aborts the upstream request.

## Commands

```bash
npm start                 # start gateway
npm run doctor            # inspect local Codex and config state
npm run install:workbuddy # install WorkBuddy model entries
npm test                  # run tests
```

Equivalent CLI:

```bash
./bin/workbuddy-codex.mjs serve
./bin/workbuddy-codex.mjs doctor
./bin/workbuddy-codex.mjs install-workbuddy
```

## Safety Defaults

- Server binds to `127.0.0.1`.
- Codex sandbox defaults to `read-only`.
- Codex approval policy defaults to `never`.
- Extra Codex command/file/permission approval requests are denied by default.
- Emergency token proxy is disabled unless the user explicitly accepts risk.
- Tokens are redacted from status output.

## Limitations

- The gateway cannot make WorkBuddy and Codex share a native internal state model; it bridges protocols.
- If the Codex backend itself is slow, persistent app-server mode reduces local startup overhead but cannot remove upstream latency.
- WorkBuddy must actually send OpenAI `tools` for the tool-call bridge to preserve its own agent tooling.
- Tool calls may still require a request/response round trip because WorkBuddy must execute the requested tool before Codex can continue.
- Image inputs are not advertised as supported. If WorkBuddy sends an image block anyway, the gateway marks it as unsupported in the Codex transcript rather than silently pretending it was understood.
- Usage numbers are approximate estimates for WorkBuddy compatibility, not provider billing data.
