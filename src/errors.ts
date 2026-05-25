export type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "not_found_error"
  | "rate_limit_error"
  | "request_too_large"
  | "overloaded_error"
  | "api_error";

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
  };
}

export function anthropicError(
  type: AnthropicErrorType,
  message: string
): AnthropicErrorBody {
  return {
    type: "error",
    error: {
      type,
      message
    }
  };
}

export function upstreamErrorType(status: number): AnthropicErrorType {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529 || status === 503 || status === 504) return "overloaded_error";
  return "api_error";
}
