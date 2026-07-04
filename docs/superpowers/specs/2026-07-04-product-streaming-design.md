# Product Streaming Design

## Goal

Make WorkBuddy responses feel product-ready by delivering true incremental SSE for both normal Codex app-server mode and emergency token-proxy mode while preserving existing non-streaming JSON behavior.

## Scope

- `codex-app-server` streams `item/agentMessage/delta` notifications as OpenAI-compatible `chat.completion.chunk` frames when the request body has `stream: true`.
- `codex-token-proxy` transparently forwards upstream SSE bodies instead of buffering them into JSON.
- Non-streaming requests keep returning OpenAI-compatible JSON completions.
- Tool-call responses use OpenAI-compatible tool-call payloads. If the request is streaming, the gateway emits a tool-call SSE chunk and `[DONE]`; if not, it returns the existing JSON payload.
- Client disconnects cancel the active Codex turn or upstream fetch.
- Request logs record stream lifecycle events without logging every token.

## Architecture

The HTTP layer owns OpenAI wire-format responses. Providers own upstream orchestration and expose either completed results or stream results:

- `message`: complete assistant text.
- `tool_calls`: OpenAI tool-call payload.
- `raw`: buffered upstream response for non-SSE token proxy calls.
- `raw_stream`: upstream web stream to forward byte-for-byte.
- `message_stream`: async iterable of assistant deltas plus an optional cancel hook.

`AppServerProvider` keeps its existing non-streaming path and adds a streaming path that resolves immediately after `turn/start`, then yields deltas as Codex app-server notifications arrive. `GatewayServer` converts those deltas into OpenAI SSE frames and sends stop plus `[DONE]` on completion.

`TokenProxyProvider` detects `text/event-stream` and returns the upstream body stream with status and selected headers. It does not parse or reserialize SSE.

## Error Handling

- If an error happens before response headers are sent, return the existing OpenAI-compatible JSON error.
- If a stream fails after headers are sent, send an SSE error chunk when possible, then `[DONE]`.
- If the client disconnects, cancel the provider stream. For app-server this interrupts the active turn. For token-proxy this aborts the fetch.
- Preserve request timeout behavior for both streaming and non-streaming app-server calls.

## Testing

- Provider-level tests prove app-server streaming yields deltas before turn completion and interrupts on cancellation.
- Server-level tests prove streamed app-server responses use `text/event-stream` and deliver multiple chunks.
- Provider/server tests prove token-proxy forwards upstream SSE without JSON wrapping.
- Existing non-streaming and tool-call tests must continue passing.
