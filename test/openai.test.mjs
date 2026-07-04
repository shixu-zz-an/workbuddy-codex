import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompletion,
  buildSseDeltaChunk,
  buildSseDoneChunk,
  buildSseErrorChunk,
  buildSseStopChunk,
  buildSseUsageChunk,
  buildSseChunks,
  estimateUsage,
  messagesToPrompt,
  normalizeOpenAiTools,
  resolveReasoningEffort,
  stripWorkBuddyModelPrefix,
} from "../src/http/openai-compatible.mjs";

test("messagesToPrompt renders mixed chat messages into a stable Codex prompt", () => {
  const prompt = messagesToPrompt({
    model: "codex-app-server",
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "tool", name: "read_file", content: "file contents" },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  });

  assert.match(prompt, /Message 1 \(system\)/);
  assert.match(prompt, /Message 2 \(user\)/);
  assert.match(prompt, /Tool names supplied by WorkBuddy: read_file/);
  assert.match(prompt, /file contents/);
});

test("messagesToPrompt preserves WorkBuddy roles, tool calls, tool results, content blocks, and controls", () => {
  const prompt = messagesToPrompt({
    model: "custom-local:codex-app-server",
    stream: true,
    tool_choice: { type: "function", function: { name: "read_file" } },
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "System rules" },
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image_url", image_url: { url: "file:///tmp/a.png" } },
        ],
      },
      {
        role: "assistant",
        content: "I need a file",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "file contents" },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object" } } }],
  });

  assert.match(prompt, /Requested WorkBuddy model: custom-local:codex-app-server/);
  assert.match(prompt, /Stream requested: true/);
  assert.match(prompt, /Reasoning effort: high/);
  assert.match(prompt, /Tool choice:/);
  assert.match(prompt, /### Message 1 \(system\)/);
  assert.match(prompt, /### Message 3 \(assistant\)/);
  assert.match(prompt, /Assistant tool calls:/);
  assert.match(prompt, /"name":"read_file"/);
  assert.match(prompt, /### Tool result \(call-1\)/);
  assert.match(prompt, /Unsupported image input/);
  assert.match(prompt, /Available WorkBuddy tools summary:/);
  assert.match(prompt, /"description":"Read file"/);
  assert.doesNotMatch(prompt, /"inputSchema"/);
  assert.doesNotMatch(prompt, /"properties"/);
});

test("normalizeOpenAiTools converts function tools to Codex dynamic tools", () => {
  const tools = normalizeOpenAiTools([
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search files",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
  ]);

  assert.deepEqual(tools, [
    {
      type: "function",
      name: "search_files",
      description: "Search files",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ]);
});

test("buildChatCompletion returns OpenAI-compatible response shape", () => {
  const response = buildChatCompletion({ model: "codex-app-server" }, "done");

  assert.equal(response.object, "chat.completion");
  assert.equal(response.model, "codex-app-server");
  assert.equal(response.choices[0].message.role, "assistant");
  assert.equal(response.choices[0].message.content, "done");
  assert.ok(response.usage.total_tokens > 0);
});

test("estimateUsage returns non-zero approximate token counts", () => {
  const usage = estimateUsage({
    messages: [{ role: "user", content: "hello world" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
  }, "a useful response");

  assert.ok(usage.prompt_tokens > 0);
  assert.ok(usage.completion_tokens > 0);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
});

test("resolveReasoningEffort prefers request effort and normalizes xhigh", () => {
  assert.equal(resolveReasoningEffort({ reasoning_effort: "xhigh" }, "low"), "high");
  assert.equal(resolveReasoningEffort({ reasoning: { effort: "medium" } }, "low"), "medium");
  assert.equal(resolveReasoningEffort({}, "low"), "low");
  assert.equal(resolveReasoningEffort({ reasoning_effort: "invalid" }, "low"), "low");
});

test("buildSseChunks emits delta and DONE frames", () => {
  const chunks = buildSseChunks({ model: "codex-app-server" }, "hi");

  assert.match(chunks.join(""), /chat.completion.chunk/);
  assert.match(chunks.at(-1), /\[DONE\]/);
});

test("SSE helper chunks emit OpenAI-compatible streaming frames", () => {
  const request = { model: "codex-app-server" };
  const first = buildSseDeltaChunk(request, { content: "he", includeRole: true, id: "chatcmpl-test", created: 123 });
  const next = buildSseDeltaChunk(request, { content: "llo", id: "chatcmpl-test", created: 123 });
  const stop = buildSseStopChunk(request, { id: "chatcmpl-test", created: 123 });
  const usage = buildSseUsageChunk(request, "hello", { id: "chatcmpl-test", created: 123 });
  const error = buildSseErrorChunk(500, "stream failed");

  assert.deepEqual(JSON.parse(first.slice("data: ".length)).choices[0].delta, {
    role: "assistant",
    content: "he",
  });
  assert.deepEqual(JSON.parse(next.slice("data: ".length)).choices[0].delta, { content: "llo" });
  assert.equal(JSON.parse(stop.slice("data: ".length)).choices[0].finish_reason, "stop");
  assert.deepEqual(JSON.parse(usage.slice("data: ".length)).choices, []);
  assert.ok(JSON.parse(usage.slice("data: ".length)).usage.total_tokens > 0);
  assert.equal(JSON.parse(error.slice("data: ".length)).error.message, "stream failed");
  assert.equal(buildSseDoneChunk(), "data: [DONE]\n\n");
});

test("stripWorkBuddyModelPrefix handles WorkBuddy custom model prefixes", () => {
  assert.equal(stripWorkBuddyModelPrefix("custom-local:codex-token-proxy"), "codex-token-proxy");
  assert.equal(stripWorkBuddyModelPrefix("custom:codex-app-server"), "codex-app-server");
  assert.equal(stripWorkBuddyModelPrefix("codex-app-server"), "codex-app-server");
});
