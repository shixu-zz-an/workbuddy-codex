import { randomUUID } from "node:crypto";

export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.text) return part.text;
        if (part?.type === "image_url") return `[image_url: ${JSON.stringify(part.image_url)}]`;
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function compactJson(value) {
  return JSON.stringify(value);
}

function renderContentBlock(part, index) {
  if (typeof part === "string") return `Content block ${index + 1} (text)\n${part}`;
  if (!part || typeof part !== "object") return `Content block ${index + 1} (unknown)\n${String(part)}`;
  if (part.type === "text") return `Content block ${index + 1} (text)\n${part.text || ""}`;
  if (part.type === "image_url") {
    return [
      `Content block ${index + 1} (unsupported_image)`,
      `Unsupported image input received from WorkBuddy: ${compactJson(part.image_url || {})}`,
      "The current Codex bridge does not advertise image support. Ask the user for a textual description if the image is necessary.",
    ].join("\n");
  }
  if (part.type === "input_image") {
    return [
      `Content block ${index + 1} (unsupported_image)`,
      `Unsupported image input received from WorkBuddy: ${compactJson(part)}`,
      "The current Codex bridge does not advertise image support. Ask the user for a textual description if the image is necessary.",
    ].join("\n");
  }
  return `Content block ${index + 1} (${part.type || "object"})\n${compactJson(part)}`;
}

function renderStructuredContent(content) {
  if (Array.isArray(content)) return content.map((part, index) => renderContentBlock(part, index)).join("\n\n");
  return normalizeContent(content);
}

export function messagesToPrompt(requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const tools = normalizeOpenAiTools(requestBody.tools || []);
  const toolNames = tools.map((tool) => tool.name);

  const rendered = messages
    .filter((message) => message?.role !== "tool")
    .map((message, index) => {
      const role = message?.role || "unknown";
      const name = message?.name ? ` name=${message.name}` : "";
      const content = renderStructuredContent(message?.content);
      const toolCalls = message?.tool_calls ? `\n\nAssistant tool calls:\n${compactJson(message.tool_calls)}` : "";
      return `### Message ${index + 1} (${role}${name})\n${content}${toolCalls}`;
    })
    .join("\n\n");

  const toolResults = messages
    .filter((message) => message?.role === "tool")
    .map((message) => `### Tool result (${message.tool_call_id || message.name || "unknown"})\n${normalizeContent(message.content)}`)
    .join("\n\n");

  return [
    "You are Codex being used as the model backend for WorkBuddy through a local bridge.",
    "Preserve the user's language and produce the final assistant response expected by WorkBuddy.",
    "When tools are available, request tool use only when it is materially useful.",
    "Preserve WorkBuddy tool-call semantics: if a tool result is needed, request the corresponding tool call instead of pretending the result exists.",
    "",
    `Requested WorkBuddy model: ${requestBody.model || "(none)"}`,
    `Stream requested: ${Boolean(requestBody.stream)}`,
    `Reasoning effort: ${resolveReasoningEffort(requestBody, "(none)")}`,
    requestBody.tool_choice ? `Tool choice: ${compactJson(requestBody.tool_choice)}` : "Tool choice: auto/default",
    toolNames.length ? `Tool names supplied by WorkBuddy: ${toolNames.join(", ")}` : "No WorkBuddy tools supplied.",
    tools.length ? `Available WorkBuddy tools:\n${compactJson(tools)}` : "",
    "",
    "Conversation:",
    rendered || "(empty)",
    toolResults ? "\nTool results:\n" + toolResults : "",
  ].join("\n");
}

export function normalizeOpenAiTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description || "",
      inputSchema: tool.function.parameters || { type: "object", properties: {} },
    }));
}

export function extractToolResults(messages = []) {
  return messages
    .filter((message) => message?.role === "tool")
    .map((message) => ({
      toolCallId: message.tool_call_id || message.name,
      content: normalizeContent(message.content),
    }))
    .filter((result) => result.toolCallId);
}

export function resolveReasoningEffort(requestBody = {}, fallback = "low") {
  const raw = requestBody.reasoning_effort || requestBody.reasoning?.effort || fallback;
  if (raw === "xhigh" || raw === "max") return "high";
  if (raw === "minimal") return "low";
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return fallback;
}

function approximateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  return Math.max(1, Math.ceil(Math.max(chars / 4, words * 1.3)));
}

export function estimateUsage(requestBody = {}, completion = "") {
  const promptPayload = {
    messages: requestBody.messages || [],
    tools: requestBody.tools || [],
    tool_choice: requestBody.tool_choice,
    model: requestBody.model,
    reasoning_effort: requestBody.reasoning_effort,
    reasoning: requestBody.reasoning,
  };
  const prompt_tokens = approximateTokens(promptPayload);
  const completion_tokens = approximateTokens(completion || "");
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    estimated: true,
  };
}

export function buildChatCompletion(requestBody, content) {
  const usage = estimateUsage(requestBody, content);
  return {
    id: `chatcmpl-codex-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestBody.model || "codex-app-server",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

export function buildToolCallCompletion(requestBody, toolCalls) {
  const usage = estimateUsage(requestBody, toolCalls);
  return {
    id: `chatcmpl-codex-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestBody.model || "codex-app-server",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments:
                typeof toolCall.arguments === "string"
                  ? toolCall.arguments
                  : JSON.stringify(toolCall.arguments ?? {}),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage,
  };
}

export function buildSseDeltaChunk(requestBody, { content = "", includeRole = false, id, created } = {}) {
  return `data: ${JSON.stringify({
    id: id || `chatcmpl-codex-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: created || Math.floor(Date.now() / 1000),
    model: requestBody.model || "codex-app-server",
    choices: [
      {
        index: 0,
        delta: {
          ...(includeRole ? { role: "assistant" } : {}),
          content,
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
}

export function buildSseStopChunk(requestBody, { id, created } = {}) {
  return `data: ${JSON.stringify({
    id: id || `chatcmpl-codex-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: created || Math.floor(Date.now() / 1000),
    model: requestBody.model || "codex-app-server",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`;
}

export function buildSseErrorChunk(statusCode, message, details = undefined) {
  return `data: ${JSON.stringify(openAiError(statusCode, message, details).body)}\n\n`;
}

export function buildSseDoneChunk() {
  return "data: [DONE]\n\n";
}

export function buildSseChunks(requestBody, content) {
  const id = `chatcmpl-codex-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return [
    buildSseDeltaChunk(requestBody, { content, includeRole: true, id, created }),
    buildSseStopChunk(requestBody, { id, created }),
    buildSseDoneChunk(),
  ];
}

export function openAiError(statusCode, message, details = undefined) {
  return {
    statusCode,
    body: {
      error: {
        message,
        type: "workbuddy_codex_error",
        details,
      },
    },
  };
}

export function stripWorkBuddyModelPrefix(model = "") {
  return String(model).replace(/^(custom-local:|custom:)/, "");
}
