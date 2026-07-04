# Product Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build true incremental SSE streaming for WorkBuddy Codex gateway responses.

**Architecture:** The gateway keeps OpenAI wire-format ownership while providers expose stream-capable result objects. App-server streaming converts Codex notification deltas into async iterable deltas; token-proxy streaming forwards upstream SSE bodies transparently.

**Tech Stack:** Node.js HTTP server, Web Streams, async iterables, `node:test`, no runtime npm dependencies.

---

### Task 1: OpenAI SSE Helpers

**Files:**
- Modify: `src/http/openai-compatible.mjs`
- Test: `test/openai.test.mjs`

- [ ] Add tests for role, delta, stop, error, and DONE SSE frame builders.
- [ ] Implement reusable `buildSseDeltaChunk`, `buildSseStopChunk`, `buildSseErrorChunk`, and `buildSseDoneChunk` helpers.
- [ ] Keep `buildSseChunks` as a compatibility wrapper.
- [ ] Run `npm test -- test/openai.test.mjs`.

### Task 2: App-Server Provider Streaming

**Files:**
- Modify: `src/providers/app-server-provider.mjs`
- Test: `test/providers.test.mjs`

- [ ] Add a failing provider test showing streaming yields deltas before `turn/completed`.
- [ ] Add a failing provider test showing stream cancellation calls `turn/interrupt`.
- [ ] Add provider state fields for stream queues, completion, errors, and cancellation.
- [ ] Add `completeStream(requestBody)` that starts a turn and returns `{ type: "message_stream", deltas, cancel }`.
- [ ] Keep existing `complete(requestBody)` behavior intact for non-streaming and tool calls.
- [ ] Run `npm test -- test/providers.test.mjs`.

### Task 3: Token Proxy Transparent SSE

**Files:**
- Modify: `src/providers/token-proxy-provider.mjs`
- Test: `test/providers.test.mjs`

- [ ] Add a failing provider test for `stream: true` upstream `text/event-stream`.
- [ ] Return `{ type: "raw_stream", body, headers, cancel }` without calling `response.text()` for SSE.
- [ ] Use an `AbortController` so gateway cancellation can abort the upstream fetch.
- [ ] Preserve buffered JSON/text behavior for non-SSE responses.
- [ ] Run `npm test -- test/providers.test.mjs`.

### Task 4: Gateway Stream Responses

**Files:**
- Modify: `src/server.mjs`
- Test: `test/server.test.mjs`

- [ ] Add a failing server test for app-server streamed SSE with multiple chunks.
- [ ] Add a failing server test for token-proxy SSE not being JSON wrapped.
- [ ] Route `body.stream` through provider stream capability.
- [ ] Add `#sse`, `#rawStream`, and cancellation plumbing for `req.close`/`res.close`.
- [ ] Log `stream_started`, `stream_completed`, `stream_cancelled`, and `stream_error`.
- [ ] Run `npm test -- test/server.test.mjs`.

### Task 5: Documentation and Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/RISKS.md`

- [ ] Update README features and limitations to describe true streaming.
- [ ] Update architecture docs with streaming flow and cancellation behavior.
- [ ] Update risks around token-proxy streaming transparency.
- [ ] Run full `npm test`.
- [ ] Commit and push.
