import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryIdScope, MemoryProvider } from "../provider.js";
import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
} from "../types.js";
import { InMemoryProvider, type InMemoryProviderOptions } from "./in-memory-provider.js";

interface FileStoreShape {
  version: number;
  records: MemoryRecord[];
}

const STORE_VERSION = 1;

export type FileProviderOptions = InMemoryProviderOptions;

/**
 * InMemoryProvider plus a JSON snapshot, so hybrid search comes along for free.
 *
 * Vectors are NOT persisted; they are recomputed on load. persist() rewrites the
 * whole store on every write, so a production snapshot (~5.6MB / ~3,700 records)
 * would grow by another ~7.6MB of base64 float32 — 2-3x write amplification on
 * the hot path, for data that is a derived cache of whatever model is currently
 * configured. Recomputing also keeps the store format at version 1, so an older
 * binary can still read the file, and makes a model or dimension change
 * self-healing rather than a silent mix of two vector spaces. The cost is paid
 * at load, in the background (see InMemoryProvider.restore), so a cold start is
 * not blocked: search is BM25-only for the first moments after boot.
 */
export class FileProvider implements MemoryProvider {
  private readonly inner: InMemoryProvider;
  private loading: Promise<void> | null = null;
  private pendingPersist: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly filePath: string,
    options: FileProviderOptions = {},
  ) {
    this.inner = new InMemoryProvider(options);
  }

  // Single-flight, so concurrent first requests cannot double-load or race a write.
  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await this.assertWritable(dir);

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as FileStoreShape;
      if (!Array.isArray(parsed.records)) {
        throw new Error("Invalid file provider store format");
      }
      // restore(), not ingest(): indexes lexically now, embeds in the background.
      await this.inner.restore(parsed.records);
    } catch (error) {
      const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        this.loading = null; // let a caller retry a transient read failure
        throw error;
      }
      await this.persist();
    }
  }

  /**
   * Fail at load time rather than per-write. persist() creates `<file>.tmp` in
   * this directory, so directory write permission is required even when the
   * store file itself is readable — a mounted volume owned by another uid reads
   * fine and then rejects every write with EACCES.
   */
  private async assertWritable(dir: string): Promise<void> {
    try {
      await fs.access(dir, fsConstants.W_OK);
    } catch (cause) {
      const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
      this.loading = null;
      throw new Error(
        `memory-core cannot write to "${dir}" as uid=${uid}, so no memory could be persisted. ` +
          `If this is a mounted volume, chown it to the runtime user: chown -R ${uid}:${uid} ${dir}`,
        { cause },
      );
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.inner.dumpRecords();
    const payload: FileStoreShape = {
      version: STORE_VERSION,
      records: snapshot,
    };
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
    await fs.rename(tmpPath, this.filePath);
  }

  /**
   * Coalesces writes. A full snapshot is O(N) to serialize, so N writes in the
   * same tick collapse into one file write instead of N. Still resolves only
   * after the caller's data is on disk, so durability is unchanged.
   */
  private queuePersist(): Promise<void> {
    this.dirty = true;
    if (this.pendingPersist) return this.pendingPersist;

    this.pendingPersist = (async () => {
      try {
        await Promise.resolve(); // let same-tick writes join this batch
        while (this.dirty) {
          this.dirty = false;
          await this.persist();
        }
      } finally {
        this.pendingPersist = null;
      }
    })();

    return this.pendingPersist;
  }

  /** Waits for any in-flight snapshot to reach disk. */
  async flush(): Promise<void> {
    if (this.pendingPersist) await this.pendingPersist;
  }

  /**
   * Resolves once every loaded record has a vector (or the embedder has given
   * up). Vectors are rebuilt in the background after load, so callers that need
   * semantic search to be warm — tests, a readiness probe — await this.
   */
  async awaitEmbeddings(): Promise<void> {
    await this.ensureLoaded();
    await this.inner.backfillEmbeddings();
  }

  async close(): Promise<void> {
    await this.flush();
  }

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    const saved = await this.inner.ingest(records);
    await this.queuePersist();
    return saved;
  }

  async findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    return this.inner.findDuplicate(candidate);
  }

  async update(record: MemoryRecord): Promise<MemoryRecord> {
    await this.ensureLoaded();
    const updated = await this.inner.update(record);
    await this.queuePersist();
    return updated;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    await this.ensureLoaded();
    return this.inner.search(query);
  }

  async listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    return this.inner.listByActor(tenantId, appId, actorId);
  }

  async getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    return this.inner.getById(id, scope);
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    const updated = await this.inner.applyFeedback(feedback);
    if (updated) await this.queuePersist();
    return updated;
  }

  async compact(): Promise<MemoryCompactResult> {
    await this.ensureLoaded();
    const result = await this.inner.compact();
    await this.queuePersist();
    return result;
  }

  async health() {
    await this.ensureLoaded();
    const inner = await this.inner.health();
    return {
      ok: true,
      provider: "file",
      detail: `path=${this.filePath}, ${inner.detail}`,
    };
  }
}
