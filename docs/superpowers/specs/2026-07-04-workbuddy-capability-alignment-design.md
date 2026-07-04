# WorkBuddy Capability Alignment Design

## Goal

Make the Codex bridge behave like a product-grade WorkBuddy custom model by aligning the model metadata, request semantics, tool-call behavior, streaming behavior, reasoning controls, usage reporting, and limit handling that WorkBuddy actually uses.

## Evidence

WorkBuddy's runtime code and logs show that custom model fields change behavior:

- `supportsToolCall: false` causes WorkBuddy to remove `tools` and `tool_choice`.
- `supportsImages: false` causes image inputs to be filtered or flattened before the request reaches the model.
- Custom local models use the `custom-local:` prefix in WorkBuddy and the model id is stripped before sending to the custom endpoint.
- Internal models expose richer metadata such as `maxAllowedSize`, `credits`, descriptions, `temperature`, `supportsReasoning`, `onlyReasoning`, and `reasoning`.

The bridge must therefore keep metadata honest and make the gateway behavior match the metadata.

## Scope

- Write richer WorkBuddy model entries for `codex-app-server` and `codex-token-proxy`.
- Preserve tool-call support and do not falsely advertise image support.
- Keep reasoning support configurable and default it off until the bridge can faithfully handle WorkBuddy reasoning UI semantics.
- Replace the loose text prompt renderer with a structured WorkBuddy transcript compiler that preserves roles, assistant tool calls, tool results, and content-block intent.
- Map WorkBuddy reasoning effort fields to Codex app-server effort when present, without claiming reasoning output support.
- Return estimated usage instead of all-zero usage.
- Enforce configured input/output limits before dispatching to Codex.
- Add test fixtures based on WorkBuddy-style custom model requests.

## Model Metadata

`installWorkBuddyModel` should write both root-array and object-wrapped formats safely:

- Preserve the user's existing file shape where possible.
- If the file is a root array, keep root array compatibility.
- If the file is `{ models, availableModels }`, preserve that object shape and `availableModels`.

Each installed model should include:

- `id`, `name`, `vendor`, `url`, `apiKey`
- `tags: ["custom"]`
- `trustLevel: "custom"`
- `supportsToolCall: true`
- `supportsImages: false`
- `disabledMultimodal: true`
- `supportsReasoning: false` by default
- `onlyReasoning: false`
- `maxInputTokens`, `maxOutputTokens`, `maxAllowedSize`
- `temperature`
- `credits`
- `descriptionZh`, `descriptionEn`

## Request Semantics

The bridge should compile WorkBuddy messages into a structured transcript that Codex can understand:

- Preserve message roles explicitly.
- Preserve assistant tool calls as structured JSON blocks.
- Preserve tool results as their own sections.
- Preserve content blocks with type labels.
- Convert images into explicit unsupported-image markers rather than silently dropping them at the gateway.
- Include request controls such as requested model, stream mode, tool choice, reasoning effort, and available tool schemas.

## Reasoning

WorkBuddy may send `reasoning_effort`, `reasoning.effort`, or related settings. The gateway should:

- Normalize supported efforts to Codex effort values.
- Use request-level effort when present; otherwise use config default.
- Not emit reasoning chunks or advertise reasoning support until a real reasoning output mapping exists.

## Usage and Limits

The gateway should estimate usage from request and response text. The estimate does not need billing precision, but it must not be all zero. If estimated input or requested output exceeds configured limits, return an OpenAI-compatible error before starting a Codex turn.

## Testing

- WorkBuddy model install tests for rich metadata and file shape preservation.
- Transcript compiler tests for roles, tool calls, tool results, image markers, tool schemas, and reasoning controls.
- Provider tests proving request-level reasoning effort reaches `turn/start`.
- Server tests proving limits return OpenAI-compatible errors.
- Response tests proving usage is populated.
