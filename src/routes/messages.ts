import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AnthropicBetaDenylistStore } from "../anthropic-beta-denylist.js";
import type { AppConfig } from "../config.js";
import { getProxyCredential, isAuthorizedProxyRequest } from "../auth/proxy-auth.js";
import { GithubOAuthTokenError } from "../auth/github-token.js";
import type { CopilotTokenProvider } from "../adapters/copilot-token.js";
import { CopilotTokenError } from "../adapters/copilot-token.js";
import {
  aggregateAnthropicSseResponse,
  AnthropicStreamError
} from "../adapters/anthropic-stream.js";
import { anthropicError, upstreamErrorType } from "../errors.js";
import { mapModelForCopilot, ModelNotAllowedError } from "../models/registry.js";

const messageRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.unknown()),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional()
  })
  .passthrough();

export interface MessageRouteOptions {
  config: AppConfig;
  tokenProvider: CopilotTokenProvider;
  anthropicBetaDenylistStore: AnthropicBetaDenylistStore;
  fetchFn?: typeof fetch;
}

export async function registerMessageRoutes(
  app: FastifyInstance,
  options: MessageRouteOptions
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;

  app.post("/v1/messages", async (request, reply) => {
    if (!isAuthorizedProxyRequest(request, options.config.proxyApiKey)) {
      return reply
        .code(401)
        .send(
          anthropicError(
            "authentication_error",
            getProxyCredential(request) ? "Invalid API key" : "Missing API key"
          )
        );
    }

    const parsed = messageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(anthropicError("invalid_request_error", "Invalid Anthropic messages request"));
    }

    let upstreamBody: Record<string, unknown>;
    try {
      const upstreamModel = mapModelForCopilot(options.config, parsed.data.model);
      upstreamBody = {
        ...parsed.data,
        model: upstreamModel,
        stream: parsed.data.stream === true
      };

      request.log.info(
        {
          model: parsed.data.model,
          upstreamModel,
          stream: upstreamBody.stream,
          messageCount: parsed.data.messages.length
        },
        "proxying Anthropic messages request"
      );
    } catch (error) {
      if (error instanceof ModelNotAllowedError) {
        return reply
          .code(400)
          .send(
            anthropicError(
              "invalid_request_error",
              `Model is not allowed by this proxy: ${error.model}`
            )
          );
      }
      throw error;
    }

    return proxyMessages({
      request,
      reply,
      config: options.config,
      tokenProvider: options.tokenProvider,
      anthropicBetaDenylistStore: options.anthropicBetaDenylistStore,
      fetchFn,
      upstreamBody
    });
  });
}

interface ProxyMessagesOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  config: AppConfig;
  tokenProvider: CopilotTokenProvider;
  anthropicBetaDenylistStore: AnthropicBetaDenylistStore;
  fetchFn: typeof fetch;
  upstreamBody: Record<string, unknown>;
}

async function proxyMessages(options: ProxyMessagesOptions): Promise<FastifyReply | void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.config.requestTimeoutMs);

  const closeHandler = (): void => {
    if (!options.reply.raw.writableEnded) {
      controller.abort();
    }
  };
  options.reply.raw.on("close", closeHandler);

  try {
    const upstreamResponse = await callCopilotMessagesWithRetries(options, controller.signal);

    return sendUpstreamResponse(options.request, options.reply, upstreamResponse, {
      stream: options.upstreamBody.stream === true,
      fallbackModel:
        typeof options.upstreamBody.model === "string"
          ? options.upstreamBody.model
          : options.config.defaultModel
    });
  } catch (error) {
    return sendProxyError(options.request, options.reply, error);
  } finally {
    clearTimeout(timeout);
    options.reply.raw.off("close", closeHandler);
  }
}

async function callCopilotMessagesWithRetries(
  options: ProxyMessagesOptions,
  signal: AbortSignal
): Promise<Response> {
  const learnedDeniedBetas = new Set<string>();
  const maxUnsupportedBetaRetries = 8;

  for (let attempt = 0; ; attempt += 1) {
    const response = await callCopilotMessagesWithAuthRetry(
      options,
      signal,
      learnedDeniedBetas
    );

    options.request.log.info(
      {
        upstreamStatus: response.status,
        contentType: response.headers.get("content-type"),
        stream: options.upstreamBody.stream === true,
        attempt: attempt + 1
      },
      "received Copilot messages response"
    );

    if (attempt >= maxUnsupportedBetaRetries) {
      return response;
    }

    const unsupportedBetas = await learnUnsupportedBetaHeaders(
      options,
      response,
      learnedDeniedBetas
    );
    if (unsupportedBetas.length === 0) {
      return response;
    }

    for (const beta of unsupportedBetas) {
      learnedDeniedBetas.add(beta);
    }
  }
}

async function callCopilotMessagesWithAuthRetry(
  options: ProxyMessagesOptions,
  signal: AbortSignal,
  deniedBetas: ReadonlySet<string>
): Promise<Response> {
  const firstToken = await options.tokenProvider.getToken();
  let upstreamResponse = await callCopilotMessages(options, firstToken, signal, deniedBetas);

  if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
    options.tokenProvider.invalidate();
    const refreshedToken = await options.tokenProvider.getToken({ forceRefresh: true });
    upstreamResponse = await callCopilotMessages(options, refreshedToken, signal, deniedBetas);
  }

  return upstreamResponse;
}

async function learnUnsupportedBetaHeaders(
  options: ProxyMessagesOptions,
  response: Response,
  alreadyDeniedBetas: ReadonlySet<string>
): Promise<string[]> {
  if (response.status !== 400) {
    return [];
  }

  const message = await readUpstreamError(response.clone());
  const unsupportedBetas = parseUnsupportedBetaHeaders(message).filter(
    (beta) => !alreadyDeniedBetas.has(beta)
  );
  if (unsupportedBetas.length === 0) {
    return [];
  }

  try {
    await options.anthropicBetaDenylistStore.recordUnsupportedBetas(
      unsupportedBetas,
      message
    );
  } catch (error) {
    options.request.log.warn(
      { error, unsupportedAnthropicBeta: unsupportedBetas },
      "failed to persist unsupported Anthropic beta headers"
    );
  }

  options.request.log.warn(
    {
      unsupportedAnthropicBeta: unsupportedBetas,
      upstreamError: message
    },
    "learned unsupported Anthropic beta headers; retrying request"
  );

  return unsupportedBetas;
}

async function callCopilotMessages(
  options: ProxyMessagesOptions,
  access: { token: string; apiBase: string },
  signal: AbortSignal,
  deniedBetas: ReadonlySet<string>
): Promise<Response> {
  const url = `${access.apiBase}/v1/messages`;
  return options.fetchFn(url, {
    method: "POST",
    signal,
    headers: await buildCopilotHeaders(options.request, options, access.token, deniedBetas),
    body: JSON.stringify(options.upstreamBody)
  });
}

async function buildCopilotHeaders(
  request: FastifyRequest,
  options: ProxyMessagesOptions,
  copilotToken: string,
  additionalDeniedBetas: ReadonlySet<string>
): Promise<HeadersInit> {
  const requestId = randomUUID();
  const anthropicVersion =
    firstHeaderValue(request.headers["anthropic-version"]) ?? "2023-06-01";
  const requestedAnthropicBeta = firstHeaderValue(request.headers["anthropic-beta"]);
  const anthropicBeta = await buildAnthropicBetaHeader(
    request,
    options.anthropicBetaDenylistStore,
    requestedAnthropicBeta,
    additionalDeniedBetas
  );
  if (anthropicBeta.ignored.length > 0) {
    request.log.info(
      { ignoredAnthropicBeta: anthropicBeta.ignored, source: anthropicBeta.source },
      "filtered unsupported Anthropic beta headers"
    );
  }
  const accept = firstHeaderValue(request.headers.accept) ?? "application/json, text/event-stream";

  const headers: Record<string, string> = {
    accept,
    authorization: `Bearer ${copilotToken}`,
    "content-type": "application/json",
    "anthropic-version": anthropicVersion,
    "openai-intent": "messages-proxy",
    "x-github-api-version": "2026-01-09",
    "x-initiator": "user",
    "x-interaction-id": requestId,
    "x-interaction-type": "messages-proxy",
    "x-request-id": requestId,
    "editor-version": "vscode/1.101.0",
    "editor-plugin-version": "copilot-chat/0.28.0",
    "user-agent": "GitHubCopilotChat/0.28.0"
  };

  if (anthropicBeta.header) {
    headers["anthropic-beta"] = anthropicBeta.header;
  }

  return headers;
}

async function buildAnthropicBetaHeader(
  request: FastifyRequest,
  store: AnthropicBetaDenylistStore,
  requestedBetas: string | undefined,
  additionalDeniedBetas: ReadonlySet<string>
): Promise<{ header: string | undefined; ignored: string[]; source: string }> {
  const requested = requestedBetas ? parseBetaHeader(requestedBetas) : [];
  if (requested.length === 0) {
    return { header: undefined, ignored: [], source: "none" };
  }

  let deniedBetas = new Set<string>(additionalDeniedBetas);
  try {
    const persistedDeniedBetas = await store.getActiveBetas();
    deniedBetas = new Set([...persistedDeniedBetas, ...additionalDeniedBetas]);
  } catch (error) {
    request.log.warn({ error }, "failed to load Anthropic beta denylist");
  }

  const forwarded = requested.filter((beta) => !deniedBetas.has(beta));
  const ignored = requested.filter((beta) => deniedBetas.has(beta));

  return {
    header: forwarded.length > 0 ? forwarded.join(",") : undefined,
    ignored,
    source: additionalDeniedBetas.size > 0 ? "retry" : "denylist"
  };
}

function parseBetaHeader(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function sendUpstreamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  upstreamResponse: Response,
  options: { stream: boolean; fallbackModel: string }
): Promise<FastifyReply | void> {
  const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";

  reply.code(upstreamResponse.status);

  const requestId = upstreamResponse.headers.get("x-request-id");
  if (requestId) {
    reply.header("x-request-id", requestId);
  }

  if (!upstreamResponse.ok) {
    const message = await readUpstreamError(upstreamResponse);
    request.log.warn(
      {
        upstreamStatus: upstreamResponse.status,
        upstreamError: message
      },
      "Copilot messages request failed"
    );
    reply.header("content-type", "application/json");
    return reply.send(
      anthropicError(upstreamErrorType(upstreamResponse.status), message)
    );
  }

  if (!upstreamResponse.body) {
    reply.header("content-type", contentType);
    return reply.send();
  }

  if (!options.stream && isEventStreamContentType(contentType)) {
    try {
      const body = await aggregateAnthropicSseResponse(
        upstreamResponse,
        options.fallbackModel
      );
      reply.header("content-type", "application/json");
      return reply.send(body);
    } catch (error) {
      if (error instanceof AnthropicStreamError) {
        reply.code(502);
        reply.header("content-type", "application/json");
        return reply.send(anthropicError("api_error", error.message));
      }

      throw error;
    }
  }

  reply.header("content-type", contentType);
  if (options.stream) {
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    reply.header("x-accel-buffering", "no");
  }

  return reply.send(Readable.fromWeb(upstreamResponse.body as NodeReadableStream));
}

async function readUpstreamError(response: Response): Promise<string> {
  const fallback = `Upstream returned HTTP ${response.status}`;
  let text: string;

  try {
    text = await response.text();
  } catch {
    return fallback;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error?: { message?: unknown } }).error?.message === "string"
    ) {
      return truncateUpstreamError((parsed as { error: { message: string } }).error.message);
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return truncateUpstreamError((parsed as { message: string }).message);
    }
  } catch {
    return truncateUpstreamError(trimmed);
  }

  return truncateUpstreamError(trimmed);
}

function truncateUpstreamError(message: string): string {
  const maxLength = 2000;
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength)}...`;
}

function parseUnsupportedBetaHeaders(message: string): string[] {
  const match = message.match(/unsupported beta header\(s\):\s*(.+)$/i);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((item) => item.trim().replace(/^[\s"'`]+|[\s"'`.;]+$/g, ""))
    .filter(Boolean);
}

function sendProxyError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply {
  if (error instanceof GithubOAuthTokenError) {
    request.log.warn({ errorName: error.name }, "proxy authentication failed");
    return reply
      .code(401)
      .send(anthropicError("authentication_error", error.message));
  }

  if (error instanceof CopilotTokenError) {
    request.log.warn(
      { errorName: error.name, status: error.status, message: error.message },
      "Copilot token exchange failed"
    );

    if (error.status === 401 || error.status === 404) {
      return reply
        .code(401)
        .send(anthropicError("authentication_error", error.message));
    }

    return reply
      .code(error.status)
      .send(anthropicError(upstreamErrorType(error.status), error.message));
  }

  if (error instanceof Error && error.name === "AbortError") {
    request.log.warn({ errorName: error.name }, "upstream request timed out");
    return reply
      .code(529)
      .send(anthropicError("overloaded_error", "Upstream request timed out"));
  }

  request.log.error({ error }, "proxy request failed");
  return reply
    .code(500)
    .send(anthropicError("api_error", "Proxy request failed"));
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isEventStreamContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}
