import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompletion,
  buildSseChunks,
  messagesToPrompt,
  normalizeOpenAiTools,
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
});

test("buildSseChunks emits delta and DONE frames", () => {
  const chunks = buildSseChunks({ model: "codex-app-server" }, "hi");

  assert.match(chunks.join(""), /chat.completion.chunk/);
  assert.match(chunks.at(-1), /\[DONE\]/);
});

test("stripWorkBuddyModelPrefix handles WorkBuddy custom model prefixes", () => {
  assert.equal(stripWorkBuddyModelPrefix("custom-local:codex-token-proxy"), "codex-token-proxy");
  assert.equal(stripWorkBuddyModelPrefix("custom:codex-app-server"), "codex-app-server");
  assert.equal(stripWorkBuddyModelPrefix("codex-app-server"), "codex-app-server");
});
