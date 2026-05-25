import type { AppConfig } from "../config.js";
import type { GithubTokenProvider } from "../auth/github-token.js";

export interface CopilotAccessToken {
  token: string;
  apiBase: string;
}

export interface CopilotTokenProvider {
  getToken(options?: { forceRefresh?: boolean }): Promise<CopilotAccessToken>;
  invalidate(): void;
}

interface CopilotTokenResponse {
  token?: unknown;
  expires_at?: unknown;
  refresh_in?: unknown;
  endpoints?: {
    api?: unknown;
  };
}

interface CachedCopilotToken extends CopilotAccessToken {
  expiresAtMs: number;
  refreshAtMs: number;
}

export class CopilotTokenManager implements CopilotTokenProvider {
  private cached?: CachedCopilotToken;
  private inFlight?: Promise<CopilotAccessToken>;

  constructor(
    private readonly config: AppConfig,
    private readonly githubTokenProvider: GithubTokenProvider,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async getToken(options: { forceRefresh?: boolean } = {}): Promise<CopilotAccessToken> {
    if (!options.forceRefresh && this.cached && !this.shouldRefresh(this.cached)) {
      return { token: this.cached.token, apiBase: this.cached.apiBase };
    }

    if (this.inFlight && !options.forceRefresh) {
      return this.inFlight;
    }

    const refresh = this.refreshToken();
    this.inFlight = refresh;

    try {
      return await refresh;
    } finally {
      if (this.inFlight === refresh) {
        this.inFlight = undefined;
      }
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private shouldRefresh(token: CachedCopilotToken): boolean {
    const now = Date.now();
    return now >= token.refreshAtMs || now >= token.expiresAtMs - this.config.copilotTokenRefreshSkewMs;
  }

  private async refreshToken(): Promise<CopilotAccessToken> {
    const githubToken = await this.githubTokenProvider.getToken();
    const url = `${this.config.githubApiBase}/copilot_internal/v2/token`;
    let response = await this.fetchToken(url, githubToken, "Bearer");

    if ([401, 403, 404].includes(response.status)) {
      response = await this.fetchToken(url, githubToken, "token");
    }

    if (!response.ok) {
      const detail = await readTokenErrorDetail(response);
      throw new CopilotTokenError(
        response.status,
        `Failed to fetch Copilot token: HTTP ${response.status}${detail ? ` - ${detail}` : ""}`
      );
    }

    const payload = (await response.json()) as CopilotTokenResponse;
    if (typeof payload.token !== "string" || payload.token.length === 0) {
      throw new CopilotTokenError(500, "Copilot token response did not include token");
    }

    const now = Date.now();
    const expiresAtMs = parseExpiresAt(payload.expires_at) ?? now + 25 * 60 * 1000;
    const refreshAtMs =
      parseRefreshAt(now, payload.refresh_in) ??
      Math.max(now, expiresAtMs - this.config.copilotTokenRefreshSkewMs);
    const apiBase =
      typeof payload.endpoints?.api === "string" && payload.endpoints.api.length > 0
        ? trimTrailingSlash(payload.endpoints.api)
        : this.config.copilotApiBase;

    this.cached = {
      token: payload.token,
      apiBase,
      expiresAtMs,
      refreshAtMs
    };

    return { token: payload.token, apiBase };
  }

  private fetchToken(
    url: string,
    githubToken: string,
    scheme: "Bearer" | "token"
  ): Promise<Response> {
    return this.fetchFn(url, {
      method: "GET",
      headers: {
        accept: "*/*",
        authorization: `${scheme} ${githubToken}`,
        "user-agent": "GitHubCopilotChat/0.49.0",
        "x-github-api-version": "2025-04-01"
      }
    });
  }
}

export class CopilotTokenError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "CopilotTokenError";
  }
}

function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

async function readTokenErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return truncateErrorDetail(extractErrorDetail(parsed) ?? trimmed);
    } catch {
      return truncateErrorDetail(trimmed);
    }
  } catch {
    return undefined;
  }
}

function extractErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.message,
    record.error_description,
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>).message
      : record.error
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function truncateErrorDetail(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function parseRefreshAt(now: number, value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return now + value * 1000;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return now + parsed * 1000;
    }
  }

  return undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
