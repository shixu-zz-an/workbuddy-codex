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

export function messagesToPrompt(requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const toolNames = Array.isArray(requestBody.tools)
    ? requestBody.tools.map((tool) => tool?.function?.name || tool?.name || tool?.type).filter(Boolean)
    : [];

  const rendered = messages
    .filter((message) => message?.role !== "tool")
    .map((message, index) => {
      const role = message?.role || "unknown";
      const name = message?.name ? ` name=${message.name}` : "";
      const content = normalizeContent(message?.content);
      const toolCalls = message?.tool_calls ? `\nTool calls: ${JSON.stringify(message.tool_calls)}` : "";
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
    "",
    `Requested WorkBuddy model: ${requestBody.model || "(none)"}`,
    toolNames.length ? `Tool names supplied by WorkBuddy: ${toolNames.join(", ")}` : "No WorkBuddy tools supplied.",
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

export function buildChatCompletion(requestBody, content) {
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
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function buildToolCallCompletion(requestBody, toolCalls) {
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
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
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
