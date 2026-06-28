import type { Tweet } from "./types.ts";

/**
 * Tweet Store: date-scoped JSON files + a single cursor.json.
 * See CONTEXT.md "Tweet Store". Writes are atomic (tmp + rename) to prevent
 * corruption of the Fetch Cursor on crash.
 */

interface DayFile {
  date: string; // YYYY-MM-DD JST
  posts: Tweet[];
}

interface CursorFile {
  /** Newest fetched post ID, or null on first run. */
  sinceId: string | null;
  /** ISO timestamp of last successful poll. */
  updatedAt: string;
}

export class Store {
  constructor(private storeDir: string) {}

  private dayPath(date: string): string {
    return `${this.storeDir}/${date}.json`;
  }
  private cursorPath(): string {
    return `${this.storeDir}/cursor.json`;
  }

  /** Ensure the store directory exists. */
  async init(): Promise<void> {
    await Bun.file(this.storeDir).exists ? undefined : undefined;
    try {
      await Bun.write(this.storeDir + "/.gitkeep", "");
    } catch {
      // dir creation handled lazily by writeFile in Bun (creates parent dirs)
    }
  }

  async readCursor(): Promise<CursorFile> {
    const path = this.cursorPath();
    if (!(await Bun.file(path).exists())) {
      return { sinceId: null, updatedAt: new Date(0).toISOString() };
    }
    return await Bun.file(path).json();
  }

  /** Atomic cursor write: tmp file then rename. */
  async writeCursor(cursor: CursorFile): Promise<void> {
    const path = this.cursorPath();
    const tmp = path + ".tmp";
    await Bun.write(tmp, JSON.stringify(cursor, null, 2));
    await renameOrFallback(tmp, path);
  }

  async readDay(date: string): Promise<DayFile> {
    const path = this.dayPath(date);
    if (!(await Bun.file(path).exists())) {
      return { date, posts: [] };
    }
    const data = (await Bun.file(path).json()) as DayFile;
    const seen = new Set<string>();
    const unique = data.posts.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    if (unique.length !== data.posts.length) {
      console.warn(`[store] removed ${data.posts.length - unique.length} duplicate(s) from ${date}`);
    }
    return { date, posts: unique };
  }

  /** Append posts to the given day, deduping by id. Returns count actually added. */
  async appendPosts(date: string, posts: Tweet[]): Promise<number> {
    const day = await this.readDay(date);
    const existing = new Set(day.posts.map((p) => p.id));
    const fresh = posts.filter((p) => !existing.has(p.id));
    if (fresh.length === 0) return 0;
    day.posts.push(...fresh);
    // Keep newest-first ordering by id (Snowflake = monotonic).
    day.posts.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const path = this.dayPath(date);
    const tmp = path + ".tmp";
    await Bun.write(tmp, JSON.stringify(day, null, 2));
    await renameOrFallback(tmp, path);
    return fresh.length;
  }

  /** Persist a Window Summary alongside the day for Daily Summary reuse. */
  async saveWindowSummary(date: string, window: string, text: string): Promise<void> {
    const path = `${this.storeDir}/${date}.summaries.json`;
    let summaries: Record<string, string> = {};
    if (await Bun.file(path).exists()) {
      summaries = await Bun.file(path).json();
    }
    summaries[window] = text;
    const tmp = path + ".tmp";
    await Bun.write(tmp, JSON.stringify(summaries, null, 2));
    await renameOrFallback(tmp, path);
  }

  async readWindowSummaries(date: string): Promise<Record<string, string>> {
    const path = `${this.storeDir}/${date}.summaries.json`;
    if (!(await Bun.file(path).exists())) return {};
    return await Bun.file(path).json();
  }
}

async function renameOrFallback(from: string, to: string): Promise<void> {
  try {
    await Bun.file(from).exists; // touch
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  } catch {
    // Fallback: read+write if rename fails (e.g. cross-device tmp).
    const content = await Bun.file(from).text();
    await Bun.write(to, content);
    await Bun.write(from, "");
  }
}
