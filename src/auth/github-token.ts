import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "../config.js";

export interface GithubTokenProvider {
  getToken(options?: { forceRefresh?: boolean }): Promise<string>;
  invalidate(): void;
}

export interface GithubOAuthTokenManagerOptions {
  output?: {
    write(message: string): unknown;
  };
}

interface StoredGithubOAuthToken {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  createdAt: string;
  expiresAt?: string;
}

interface DeviceCodeResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface AccessTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export class GithubOAuthTokenManager implements GithubTokenProvider {
  private cached?: StoredGithubOAuthToken;
  private validated = false;
  private inFlight?: Promise<string>;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly options: GithubOAuthTokenManagerOptions = {}
  ) {}

  async getToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (options.forceRefresh) {
      this.invalidate();
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const resolution = this.resolveToken();
    this.inFlight = resolution;

    try {
      return await resolution;
    } finally {
      if (this.inFlight === resolution) {
        this.inFlight = undefined;
      }
    }
  }

  invalidate(): void {
    this.cached = undefined;
    this.validated = false;
  }

  private async resolveToken(): Promise<string> {
    if (this.cached && this.validated && !this.isLocallyExpired(this.cached)) {
      return this.cached.accessToken;
    }

    const stored = this.cached ?? (await this.loadStoredToken());
    if (stored && !this.isLocallyExpired(stored)) {
      const validation = await this.validateStoredToken(stored.accessToken);
      if (validation.valid) {
        const token = validation.expiresAt
          ? { ...stored, expiresAt: validation.expiresAt }
          : stored;
        this.cached = token;
        this.validated = true;
        if (validation.expiresAt && validation.expiresAt !== stored.expiresAt) {
          await this.saveToken(token);
        }
        return token.accessToken;
      }
    }

    return this.authorizeWithDeviceFlow();
  }

  private async loadStoredToken(): Promise<StoredGithubOAuthToken | undefined> {
    try {
      const raw = await readFile(this.config.copilotOAuthTokenFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredGithubOAuthToken(parsed)) {
        this.writeStatus(
          "Stored GitHub OAuth token is invalid; starting device authorization."
        );
        return undefined;
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }

      this.writeStatus(
        "Could not read stored GitHub OAuth token; starting device authorization."
      );
      return undefined;
    }
  }

  private async saveToken(token: StoredGithubOAuthToken): Promise<void> {
    const file = this.config.copilotOAuthTokenFile;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(token, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }

  private isLocallyExpired(token: StoredGithubOAuthToken): boolean {
    if (!token.expiresAt) {
      return false;
    }

    const expiresAtMs = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return true;
    }

    return Date.now() + this.config.githubOAuthTokenRefreshSkewMs >= expiresAtMs;
  }

  private async validateStoredToken(
    token: string
  ): Promise<{ valid: boolean; expiresAt?: string }> {
    const response = await this.fetchFn(`${this.config.githubApiBase}/user`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "copilot-claude-api",
        "x-github-api-version": "2022-11-28"
      }
    });

    if (response.status === 401) {
      return { valid: false };
    }

    if (!response.ok) {
      throw new GithubOAuthTokenError(
        `Failed to validate stored GitHub OAuth token: HTTP ${response.status}`
      );
    }

    const tokenExpiration = response.headers.get(
      "github-authentication-token-expiration"
    );
    return {
      valid: true,
      expiresAt: parseDateHeader(tokenExpiration)
    };
  }

  private async authorizeWithDeviceFlow(): Promise<string> {
    const device = await this.requestDeviceCode();
    const deviceCode = requireString(device.device_code, "device_code");
    const userCode = requireString(device.user_code, "user_code");
    const verificationUri = requireString(device.verification_uri, "verification_uri");
    const verificationUriComplete =
      typeof device.verification_uri_complete === "string"
        ? device.verification_uri_complete
        : undefined;
    const expiresInSeconds = numberOrDefault(device.expires_in, 900);
    let intervalSeconds = Math.max(0, numberOrDefault(device.interval, 5));
    const deadlineMs = Date.now() + expiresInSeconds * 1000;

    this.writeStatus("");
    this.writeStatus("GitHub OAuth token is missing or invalid.");
    this.writeStatus("Complete device authorization to continue:");
    this.writeStatus(`  1. Open: ${verificationUriComplete ?? verificationUri}`);
    this.writeStatus(`  2. Enter code: ${userCode}`);
    this.writeStatus("Waiting for GitHub authorization...");

    while (Date.now() < deadlineMs) {
      await sleep(intervalSeconds * 1000);

      const result = await this.pollAccessToken(deviceCode);
      if (typeof result.access_token === "string" && result.access_token.length > 0) {
        const stored: StoredGithubOAuthToken = {
          accessToken: result.access_token,
          tokenType:
            typeof result.token_type === "string" && result.token_type.length > 0
              ? result.token_type
              : "bearer",
          scope: typeof result.scope === "string" ? result.scope : undefined,
          createdAt: new Date().toISOString(),
          expiresAt: parseOAuthTokenExpiresAt(result)
        };

        await this.saveToken(stored);
        this.cached = stored;
        this.validated = true;
        this.writeStatus(`GitHub OAuth token saved to ${this.config.copilotOAuthTokenFile}`);
        return stored.accessToken;
      }

      const error = typeof result.error === "string" ? result.error : undefined;
      if (!error || error === "authorization_pending") {
        continue;
      }

      if (error === "slow_down") {
        intervalSeconds += 5;
        continue;
      }

      const detail =
        typeof result.error_description === "string"
          ? `: ${result.error_description}`
          : "";
      throw new GithubOAuthTokenError(`GitHub device authorization failed (${error})${detail}`);
    }

    throw new GithubOAuthTokenError("GitHub device authorization expired");
  }

  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
      client_id: this.config.copilotOAuthClientId
    });
    if (this.config.copilotOAuthScopes.length > 0) {
      body.set("scope", this.config.copilotOAuthScopes);
    }

    const response = await this.fetchFn(`${this.config.githubAuthBase}/login/device/code`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "copilot-claude-api"
      },
      body
    });

    const payload = (await readJson(response)) as DeviceCodeResponse;
    if (!response.ok) {
      throw new GithubOAuthTokenError(
        `Failed to start GitHub device authorization: HTTP ${response.status}${errorSuffix(payload)}`
      );
    }

    if (typeof payload.error === "string") {
      throw new GithubOAuthTokenError(
        `Failed to start GitHub device authorization (${payload.error})${errorSuffix(payload)}`
      );
    }

    return payload;
  }

  private async pollAccessToken(deviceCode: string): Promise<AccessTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.copilotOAuthClientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });

    const response = await this.fetchFn(
      `${this.config.githubAuthBase}/login/oauth/access_token`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "copilot-claude-api"
        },
        body
      }
    );

    const payload = (await readJson(response)) as AccessTokenResponse;
    if (!response.ok) {
      throw new GithubOAuthTokenError(
        `Failed to poll GitHub device authorization: HTTP ${response.status}${errorSuffix(payload)}`
      );
    }

    return payload;
  }

  private writeStatus(message: string): void {
    const output = this.options.output;
    if (output) {
      output.write(`${message}\n`);
      return;
    }

    process.stderr.write(`${message}\n`);
  }
}

export class GithubOAuthTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubOAuthTokenError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GithubOAuthTokenError("GitHub OAuth endpoint returned invalid JSON");
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new GithubOAuthTokenError(`GitHub device authorization response missing ${field}`);
}

function numberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function parseOAuthTokenExpiresAt(payload: AccessTokenResponse): string | undefined {
  if (typeof payload.expires_at === "string") {
    const parsed = Date.parse(payload.expires_at);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }

  if (typeof payload.expires_at === "number" && Number.isFinite(payload.expires_at)) {
    const ms = payload.expires_at > 10_000_000_000
      ? payload.expires_at
      : payload.expires_at * 1000;
    return new Date(ms).toISOString();
  }

  if (typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)) {
    return new Date(Date.now() + payload.expires_in * 1000).toISOString();
  }

  return undefined;
}

function parseDateHeader(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function errorSuffix(payload: { error_description?: unknown; error?: unknown }): string {
  if (typeof payload.error_description === "string" && payload.error_description.length > 0) {
    return ` - ${payload.error_description}`;
  }

  if (typeof payload.error === "string" && payload.error.length > 0) {
    return ` - ${payload.error}`;
  }

  return "";
}

function isStoredGithubOAuthToken(value: unknown): value is StoredGithubOAuthToken {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    typeof record.createdAt === "string" &&
    (record.expiresAt === undefined || typeof record.expiresAt === "string")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
