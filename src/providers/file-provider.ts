import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryProvider } from "../provider.js";
import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
} from "../types.js";
import { InMemoryProvider } from "./in-memory-provider.js";

interface FileStoreShape {
  version: number;
  records: MemoryRecord[];
}

const STORE_VERSION = 1;

export class FileProvider implements MemoryProvider {
  private readonly inner = new InMemoryProvider();
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as FileStoreShape;
      if (!Array.isArray(parsed.records)) {
        throw new Error("Invalid file provider store format");
      }
      await this.inner.ingest(parsed.records);
    } catch (error) {
      const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) throw error;
      await this.persist();
    }

    this.loaded = true;
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

  private async queuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(() => this.persist());
    await this.persistQueue;
  }

  private async persistIfCompacted(): Promise<void> {
    const compacted = await this.inner.compact();
    if (compacted.archivedExpired > 0 || compacted.archivedSuperseded > 0) {
      await this.queuePersist();
    }
  }

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    const saved = await this.inner.ingest(records);
    await this.queuePersist();
    return saved;
  }

  async findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    await this.persistIfCompacted();
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
    await this.persistIfCompacted();
    return this.inner.search(query);
  }

  async listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    await this.persistIfCompacted();
    return this.inner.listByActor(tenantId, appId, actorId);
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    await this.persistIfCompacted();
    return this.inner.getById(id);
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
    return {
      ok: true,
      provider: "file",
      detail: `path=${this.filePath}`,
    };
  }
}
