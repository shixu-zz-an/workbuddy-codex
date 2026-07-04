# Architecture

## Goals

`workbuddy-codex` lets WorkBuddy use Codex through its existing custom-model interface without modifying WorkBuddy binaries.

The project supports two modes:

- `app-server`: recommended normal mode. Uses `codex app-server` as the authenticated Codex bridge.
- `token-proxy`: emergency mode. Forwards OpenAI-compatible requests to a configured endpoint with an opt-in bearer token.

## Components

```text
bin/workbuddy-codex.mjs
  CLI entrypoint.

src/server.mjs
  HTTP server, dashboard routes, OpenAI-compatible routes.

src/providers/app-server-provider.mjs
  Main provider. Maps WorkBuddy chat/tool requests onto Codex app-server threads and turns.

src/app-server/json-rpc-line-client.mjs
  Newline-delimited JSON-RPC client for codex app-server --stdio.

src/providers/token-proxy-provider.mjs
  Emergency forwarding provider.

src/http/openai-compatible.mjs
  OpenAI-compatible request rendering, WorkBuddy transcript compilation, usage estimation, reasoning effort normalization, plus JSON and SSE response frame builders.

src/workbuddy-config.mjs
  Writes WorkBuddy custom model entries into models.json.
```

## WorkBuddy Capability Alignment

WorkBuddy changes request behavior based on model metadata. The installer therefore writes honest metadata:

- tool calls are enabled because the bridge maps WorkBuddy tools to Codex dynamic tools
- images are disabled because the bridge does not currently send image bytes to Codex
- reasoning output is disabled by default because the bridge maps effort but does not emit reasoning chunks
- `tags: ["custom"]` and `trustLevel: "custom"` make the custom-model path explicit
- context fields include `maxInputTokens`, `maxOutputTokens`, and `maxAllowedSize`

The gateway also enforces configured limits before dispatching to Codex and returns OpenAI-compatible errors for oversized requests.

## Normal Request Flow

```text
POST /v1/chat/completions
  -> select app-server provider
  -> thread/start with dynamicTools
  -> turn/start with rendered WorkBuddy messages
  -> wait for one of:
       item/tool/call
       turn/completed
```

## Streaming Request Flow

For `stream: true` app-server requests:

```text
POST /v1/chat/completions
  -> select app-server provider
  -> thread/start
  -> turn/start
  -> return text/event-stream headers
  -> emit SSE keep-alive comments while no model delta is ready
  -> item/agentMessage/delta notifications become OpenAI chat.completion.chunk frames
  -> turn/completed becomes stop chunk + optional usage chunk + data: [DONE]
```

The provider exposes the deltas as an async iterable. The HTTP server owns wire-format details, so OpenAI SSE framing is kept in one place. App-server stream timeout is treated as idle timeout and is refreshed when Codex emits delta or completed-message activity.

If the client disconnects before the stream completes, the HTTP server calls the provider cancel hook. App-server mode sends `turn/interrupt`; token-proxy mode aborts the upstream fetch.

For token-proxy requests, upstream `text/event-stream` responses are forwarded as raw streams. The gateway does not parse, buffer, or reserialize upstream SSE.

## Transcript Compilation

WorkBuddy sends OpenAI-style `messages`, `tools`, `tool_choice`, and optional reasoning controls. The bridge compiles these into a structured transcript for Codex instead of flattening them into an unlabelled chat log. The transcript preserves roles, assistant tool calls, tool results, content block types, available tool names and concise parameter summaries, stream mode, and reasoning effort. Full tool schemas are sent through Codex dynamic tools rather than duplicated into the natural-language prompt.

If Codex asks for a dynamic tool:

```text
item/tool/call
  -> gateway stores pending JSON-RPC response
  -> gateway returns OpenAI tool_calls to WorkBuddy
  -> WorkBuddy executes tool and sends role=tool result
  -> gateway resolves pending JSON-RPC response
  -> Codex continues and completes the turn
```

## Security Model

The project does not patch WorkBuddy or bypass WorkBuddy UI authorization. It only uses WorkBuddy's custom model path.

Default behavior is intentionally conservative:

- localhost only
- read-only Codex sandbox
- no automatic extra permissions
- denied approval requests
- explicit risk gate for token-proxy mode

## Why Not `codex exec`

`codex exec` works but starts a full agent process for every request. In practice this is slow because it loads local Codex state and then establishes an upstream model connection.

`codex app-server` is a long-running JSON-RPC service with thread/turn semantics, notifications, dynamic tools, and file/command events. It is the correct primitive for a custom model gateway.
