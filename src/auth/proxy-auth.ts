import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function isAuthorizedProxyRequest(
  request: FastifyRequest,
  proxyApiKey: string
): boolean {
  const provided = getProxyCredential(request);
  return typeof provided === "string" && constantTimeEqual(provided, proxyApiKey);
}

export function getProxyCredential(request: FastifyRequest): string | undefined {
  const apiKey = firstHeaderValue(request.headers["x-api-key"]);
  if (apiKey) {
    return apiKey;
  }

  const authorization = firstHeaderValue(request.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
