import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AnthropicBetaDenylistEntry {
  beta: string;
  addedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  reason?: string;
}

interface AnthropicBetaDenylistFile {
  version: 1;
  unsupportedBetas: AnthropicBetaDenylistEntry[];
}

export class AnthropicBetaDenylistStore {
  private entries: Map<string, AnthropicBetaDenylistEntry> | undefined;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getActiveBetas(now = new Date()): Promise<Set<string>> {
    await this.operation.catch(() => undefined);
    await this.ensureLoaded();

    if (this.pruneExpired(now)) {
      await this.save();
    }

    return new Set(this.entries?.keys() ?? []);
  }

  async recordUnsupportedBetas(
    betas: string[],
    reason: string,
    now = new Date()
  ): Promise<AnthropicBetaDenylistEntry[]> {
    const uniqueBetas = [...new Set(betas.map((beta) => beta.trim()).filter(Boolean))];
    if (uniqueBetas.length === 0) {
      return [];
    }

    const run = this.operation
      .catch(() => undefined)
      .then(async () => {
        await this.ensureLoaded();
        this.pruneExpired(now);

        const entries = this.requireEntries();
        const nowIso = now.toISOString();
        const expiresAt = addOneMonth(now).toISOString();
        const recorded: AnthropicBetaDenylistEntry[] = [];

        for (const beta of uniqueBetas) {
          const existing = entries.get(beta);
          const entry: AnthropicBetaDenylistEntry = {
            beta,
            addedAt: existing?.addedAt ?? nowIso,
            lastSeenAt: nowIso,
            expiresAt,
            reason
          };
          entries.set(beta, entry);
          recorded.push(entry);
        }

        await this.save();
        return recorded;
      });

    this.operation = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.entries) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.entries = new Map();
        return;
      }
      throw error;
    }

    const parsed = parseDenylistFile(raw);
    this.entries = new Map(parsed.unsupportedBetas.map((entry) => [entry.beta, entry]));
  }

  private pruneExpired(now: Date): boolean {
    const entries = this.requireEntries();
    let changed = false;

    for (const [beta, entry] of entries) {
      const expiresAt = new Date(entry.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
        entries.delete(beta);
        changed = true;
      }
    }

    return changed;
  }

  private async save(): Promise<void> {
    const entries = [...this.requireEntries().values()].sort((a, b) =>
      a.beta.localeCompare(b.beta)
    );
    const body: AnthropicBetaDenylistFile = {
      version: 1,
      unsupportedBetas: entries
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }

  private requireEntries(): Map<string, AnthropicBetaDenylistEntry> {
    if (!this.entries) {
      this.entries = new Map();
    }
    return this.entries;
  }
}

function parseDenylistFile(raw: string): AnthropicBetaDenylistFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.unsupportedBetas)) {
      return emptyFile();
    }

    return {
      version: 1,
      unsupportedBetas: parsed.unsupportedBetas.filter(isEntry)
    };
  } catch {
    return emptyFile();
  }
}

function emptyFile(): AnthropicBetaDenylistFile {
  return {
    version: 1,
    unsupportedBetas: []
  };
}

function isEntry(value: unknown): value is AnthropicBetaDenylistEntry {
  return (
    isObject(value) &&
    typeof value.beta === "string" &&
    value.beta.trim().length > 0 &&
    typeof value.addedAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    typeof value.expiresAt === "string" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function addOneMonth(date: Date): Date {
  const result = new Date(date.getTime());
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}
