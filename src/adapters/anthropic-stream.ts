import { randomUUID } from "node:crypto";

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: string;
  content: Array<Record<string, unknown>>;
  model: string;
  stop_reason: unknown;
  stop_sequence: unknown;
  usage: Record<string, unknown>;
  [key: string]: unknown;
}

interface SseEvent {
  event?: string;
  data: string;
}

type MutableObject = Record<string, unknown>;

export class AnthropicStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicStreamError";
  }
}

export async function aggregateAnthropicSseResponse(
  response: Response,
  fallbackModel: string
): Promise<AnthropicMessageResponse> {
  return aggregateAnthropicSse(await response.text(), fallbackModel);
}

export function aggregateAnthropicSse(
  body: string,
  fallbackModel: string
): AnthropicMessageResponse {
  let message: MutableObject = createBaseMessage(fallbackModel);
  let content = message.content as MutableObject[];
  const partialJsonByIndex = new Map<number, string>();

  for (const event of parseSseEvents(body)) {
    const rawData = event.data.trim();
    if (!rawData || rawData === "[DONE]") {
      continue;
    }

    const payload = parseEventPayload(rawData);
    const type = stringValue(payload.type) ?? event.event;

    if (type === "error") {
      throw new AnthropicStreamError(readErrorMessage(payload));
    }

    if (type === "message_start" && isObject(payload.message)) {
      message = {
        ...createBaseMessage(fallbackModel),
        ...payload.message
      };
      content = normalizeContent(message.content);
      message.content = content;
      continue;
    }

    if (type === "content_block_start") {
      const index = numberValue(payload.index);
      if (index === undefined || !isObject(payload.content_block)) {
        continue;
      }

      content[index] = { ...payload.content_block };
      continue;
    }

    if (type === "content_block_delta") {
      applyContentBlockDelta(content, partialJsonByIndex, payload);
      continue;
    }

    if (type === "content_block_stop") {
      const index = numberValue(payload.index);
      if (index !== undefined) {
        finalizePartialJson(content, partialJsonByIndex, index);
      }
      continue;
    }

    if (type === "message_delta") {
      if (isObject(payload.delta)) {
        if ("stop_reason" in payload.delta) {
          message.stop_reason = payload.delta.stop_reason;
        }
        if ("stop_sequence" in payload.delta) {
          message.stop_sequence = payload.delta.stop_sequence;
        }
      }

      if (isObject(payload.usage)) {
        message.usage = {
          ...normalizeUsage(message.usage),
          ...payload.usage
        };
      }
    }
  }

  for (const index of partialJsonByIndex.keys()) {
    finalizePartialJson(content, partialJsonByIndex, index);
  }

  message.content = content.filter((block) => block !== undefined);
  return normalizeMessage(message, fallbackModel);
}

function parseEventPayload(rawData: string): MutableObject {
  try {
    const parsed = JSON.parse(rawData) as unknown;
    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    throw new AnthropicStreamError("Upstream returned malformed Anthropic SSE data");
  }

  throw new AnthropicStreamError("Upstream returned unsupported Anthropic SSE data");
}

function parseSseEvents(body: string): SseEvent[] {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: SseEvent[] = [];

  for (const block of normalized.split(/\n\n+/)) {
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }

      if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }

  return events;
}

function applyContentBlockDelta(
  content: MutableObject[],
  partialJsonByIndex: Map<number, string>,
  payload: MutableObject
): void {
  const index = numberValue(payload.index);
  if (index === undefined || !isObject(payload.delta)) {
    return;
  }

  const delta = payload.delta;
  const deltaType = stringValue(delta.type);

  if (deltaType === "text_delta" && typeof delta.text === "string") {
    const block = ensureBlock(content, index, "text");
    block.text = `${stringValue(block.text) ?? ""}${delta.text}`;
    return;
  }

  if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
    const current = partialJsonByIndex.get(index) ?? "";
    partialJsonByIndex.set(index, current + delta.partial_json);
    ensureBlock(content, index, "tool_use");
    return;
  }

  if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
    const block = ensureBlock(content, index, "thinking");
    block.thinking = `${stringValue(block.thinking) ?? ""}${delta.thinking}`;
    return;
  }

  if (deltaType === "signature_delta" && typeof delta.signature === "string") {
    const block = ensureBlock(content, index, "thinking");
    block.signature = delta.signature;
    return;
  }

  if (deltaType === "citations_delta" && "citation" in delta) {
    const block = ensureBlock(content, index, "text");
    const citations = Array.isArray(block.citations) ? block.citations : [];
    citations.push(delta.citation);
    block.citations = citations;
  }
}

function finalizePartialJson(
  content: MutableObject[],
  partialJsonByIndex: Map<number, string>,
  index: number
): void {
  const partialJson = partialJsonByIndex.get(index);
  if (partialJson === undefined) {
    return;
  }

  const block = ensureBlock(content, index, "tool_use");
  partialJsonByIndex.delete(index);

  if (!partialJson.trim()) {
    block.input = {};
    return;
  }

  try {
    block.input = JSON.parse(partialJson) as unknown;
  } catch {
    block.input = {};
  }
}

function normalizeMessage(
  value: MutableObject,
  fallbackModel: string
): AnthropicMessageResponse {
  const base = createBaseMessage(fallbackModel);

  return {
    ...base,
    ...value,
    id: stringValue(value.id) ?? base.id,
    type: "message",
    role: stringValue(value.role) ?? "assistant",
    content: normalizeContent(value.content),
    model: stringValue(value.model) ?? fallbackModel,
    stop_reason: value.stop_reason ?? null,
    stop_sequence: value.stop_sequence ?? null,
    usage: normalizeUsage(value.usage)
  };
}

function createBaseMessage(model: string): AnthropicMessageResponse {
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content: [],
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0
    }
  };
}

function normalizeContent(value: unknown): MutableObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isObject).map((block) => ({ ...block }));
}

function normalizeUsage(value: unknown): MutableObject {
  const usage = isObject(value) ? { ...value } : {};

  if (typeof usage.input_tokens !== "number") {
    usage.input_tokens = 0;
  }
  if (typeof usage.output_tokens !== "number") {
    usage.output_tokens = 0;
  }

  return usage;
}

function ensureBlock(
  content: MutableObject[],
  index: number,
  defaultType: string
): MutableObject {
  const existing = content[index];
  if (existing) {
    return existing;
  }

  const created =
    defaultType === "text"
      ? { type: "text", text: "" }
      : { type: defaultType };
  content[index] = created;
  return created;
}

function readErrorMessage(payload: MutableObject): string {
  if (isObject(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  return "Upstream returned an Anthropic stream error";
}

function isObject(value: unknown): value is MutableObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
