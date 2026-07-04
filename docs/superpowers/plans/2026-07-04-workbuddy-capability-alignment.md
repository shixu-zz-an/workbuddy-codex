# WorkBuddy Capability Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Codex bridge with WorkBuddy's real custom-model capability contract without falsely advertising unsupported features.

**Architecture:** Keep WorkBuddy-specific metadata in `src/workbuddy-config.mjs`, move request compilation and usage estimation into focused OpenAI compatibility helpers, and enforce limits at the gateway before provider dispatch. Providers remain responsible for upstream Codex/token-proxy orchestration.

**Tech Stack:** Node.js, OpenAI-compatible JSON/SSE, `node:test`, no runtime npm dependencies.

---

### Task 1: Rich WorkBuddy Model Metadata

**Files:**
- Modify: `src/workbuddy-config.mjs`
- Test: `test/workbuddy-config.test.mjs`

- [ ] Write failing tests for rich metadata fields: `tags`, `trustLevel`, `maxAllowedSize`, descriptions, `disabledMultimodal`, and honest reasoning/image flags.
- [ ] Write failing tests that preserve object-shaped `{ models, availableModels }` files.
- [ ] Implement richer `modelEntry`.
- [ ] Update read/write logic to preserve root-array or object-wrapped model file shapes.
- [ ] Run `npm test -- test/workbuddy-config.test.mjs`.

### Task 2: Structured Transcript Compiler

**Files:**
- Modify: `src/http/openai-compatible.mjs`
- Test: `test/openai.test.mjs`

- [ ] Write failing tests for system/user/assistant roles, assistant `tool_calls`, tool results, array content blocks, image markers, `tool_choice`, and tool schemas.
- [ ] Replace loose prompt rendering internals with a structured transcript compiler.
- [ ] Keep exported `messagesToPrompt` for provider compatibility.
- [ ] Run `npm test -- test/openai.test.mjs`.

### Task 3: Reasoning Effort Mapping

**Files:**
- Modify: `src/http/openai-compatible.mjs`
- Modify: `src/providers/app-server-provider.mjs`
- Test: `test/openai.test.mjs`
- Test: `test/providers.test.mjs`

- [ ] Write failing tests for `reasoning_effort`, `reasoning.effort`, and config fallback.
- [ ] Implement `resolveReasoningEffort`.
- [ ] Use request-level effort for app-server `thread/start` config and `turn/start`.
- [ ] Keep metadata `supportsReasoning` false by default.
- [ ] Run `npm test -- test/openai.test.mjs test/providers.test.mjs`.

### Task 4: Usage and Limit Enforcement

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/http/openai-compatible.mjs`
- Modify: `src/server.mjs`
- Test: `test/config.test.mjs`
- Test: `test/openai.test.mjs`
- Test: `test/server.test.mjs`

- [ ] Add config defaults for input/output limits and usage estimation.
- [ ] Write failing tests proving chat responses include non-zero estimated usage.
- [ ] Write failing tests proving oversized requests fail before provider dispatch.
- [ ] Implement usage estimator and gateway preflight checks.
- [ ] Run affected tests.

### Task 5: Docs and Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/RISKS.md`

- [ ] Document the honest capability matrix.
- [ ] Document image/reasoning limitations and tool-call guarantees.
- [ ] Run `npm test`.
- [ ] Run `node --check` for `.mjs` files.
- [ ] Commit and push.
