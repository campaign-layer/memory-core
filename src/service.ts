import type { MemoryProvider } from "./provider.js";
import type {
  MemoryCompactResult,
  ContextBuildRequest,
  ContextBuildResult,
  DecayPolicy,
  MemoryFeedbackInput,
  MemoryIngestRequest,
  MemoryProfile,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryType,
} from "./types.js";
import { clamp, normalizeText, uid } from "./utils.js";

const DEFAULT_DECAY: DecayPolicy = { kind: "time", ttlDays: 180 };
const DEFAULT_SCOPE: MemoryScope = "actor";
const DEFAULT_CONFIDENCE = 0.7;
const DEFAULT_IMPORTANCE = 0.5;
const MAX_TEXT_LEN = 1000;

function summarizeText(text: string): string {
  const clean = normalizeText(text);
  if (clean.length <= 120) return clean;
  return `${clean.slice(0, 117)}...`;
}

function normalizeMemoryType(type: MemoryType): MemoryType {
  return type;
}

function normalizeRecord(record: MemoryRecord): MemoryRecord {
  const now = new Date().toISOString();
  const text = normalizeText(record.text).slice(0, MAX_TEXT_LEN);

  return {
    ...record,
    text,
    summary: record.summary ? normalizeText(record.summary).slice(0, 200) : summarizeText(text),
    confidence: clamp(record.confidence, 0, 1),
    importance: clamp(record.importance, 0, 1),
    metadata: record.metadata || {},
    firstSeenAt: record.firstSeenAt || now,
    lastSeenAt: record.lastSeenAt || now,
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    decayPolicy: record.decayPolicy || DEFAULT_DECAY,
  };
}

function buildProfileSummary(byType: Record<MemoryType, string[]>): string {
  const ordered: Array<[MemoryType, string]> = [
    ["preference", "Preferences"],
    ["goal", "Goals"],
    ["project", "Projects"],
    ["fact", "Facts"],
    ["instruction", "Instructions"],
    ["profile", "Profile"],
    ["tool_outcome", "Tool Outcomes"],
    ["episode", "Episodes"],
  ];

  const lines: string[] = [];
  for (const [type, title] of ordered) {
    const items = byType[type] || [];
    if (items.length === 0) continue;
    lines.push(`${title}:`);
    for (const item of items.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export class MemoryCoreService {
  constructor(private readonly provider: MemoryProvider) {}

  async getHealth() {
    if (!this.provider.health) {
      return {
        ok: true,
        provider: "unknown",
      };
    }
    return this.provider.health();
  }

  async ingest(input: MemoryIngestRequest): Promise<{ created: number; updated: number; records: MemoryRecord[] }> {
    const created: MemoryRecord[] = [];
    const updated: MemoryRecord[] = [];

    for (const obs of input.observations) {
      const now = obs.observedAt || new Date().toISOString();
      const candidate = normalizeRecord({
        id: uid("mem"),
        tenantId: obs.tenantId,
        appId: obs.appId,
        actorId: obs.actorId,
        threadId: obs.threadId || null,
        scope: obs.scope || DEFAULT_SCOPE,
        memoryType: normalizeMemoryType(obs.memoryType),
        text: obs.text,
        summary: obs.summary || null,
        metadata: obs.metadata || {},
        confidence: obs.confidence ?? DEFAULT_CONFIDENCE,
        importance: obs.importance ?? DEFAULT_IMPORTANCE,
        status: "active",
        source: obs.source,
        decayPolicy: obs.decayPolicy || DEFAULT_DECAY,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
        stats: {
          selectedCount: 0,
          positiveCount: 0,
          negativeCount: 0,
        },
      });

      const duplicate = await this.provider.findDuplicate(candidate);
      if (duplicate) {
        duplicate.lastSeenAt = now;
        duplicate.updatedAt = now;
        duplicate.confidence = Math.max(duplicate.confidence, candidate.confidence);
        duplicate.importance = Math.max(duplicate.importance, candidate.importance);
        duplicate.summary = duplicate.summary || candidate.summary;
        duplicate.metadata = { ...duplicate.metadata, ...candidate.metadata };
        updated.push(await this.provider.update(normalizeRecord(duplicate)));
        continue;
      }

      const [saved] = await this.provider.ingest([candidate]);
      created.push(saved);
    }

    return {
      created: created.length,
      updated: updated.length,
      records: [...created, ...updated],
    };
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    return this.provider.search(query);
  }

  async getProfile(tenantId: string, appId: string, actorId: string): Promise<MemoryProfile> {
    const records = await this.provider.listByActor(tenantId, appId, actorId);

    const byType = {
      fact: [] as string[],
      preference: [] as string[],
      goal: [] as string[],
      project: [] as string[],
      episode: [] as string[],
      tool_outcome: [] as string[],
      instruction: [] as string[],
      profile: [] as string[],
      pattern: [] as string[],
      summary: [] as string[],
    };

    for (const record of records) {
      byType[record.memoryType].push(record.text);
    }

    return {
      tenantId,
      appId,
      actorId,
      byType,
      summary: buildProfileSummary(byType),
      count: records.length,
    };
  }

  async buildContext(request: ContextBuildRequest): Promise<ContextBuildResult> {
    const maxItems = Math.min(Math.max(request.budget?.maxItems ?? 8, 1), 30);
    const maxChars = Math.min(Math.max(request.budget?.maxChars ?? 3000, 300), 20000);
    const hits = await this.search({
      query: request.query,
      filters: request.filters,
      limit: maxItems * 2,
    });

    const selected: ContextBuildResult["selectedMemories"] = [];
    let chars = 0;

    for (const hit of hits) {
      if (selected.length >= maxItems) break;
      const line = `- [${hit.memory.memoryType}] ${hit.memory.summary || hit.memory.text}`;
      if (chars + line.length > maxChars) break;
      chars += line.length;
      selected.push({
        id: hit.memory.id,
        memoryType: hit.memory.memoryType,
        text: hit.memory.text,
        score: hit.score,
        reasons: hit.reasons,
      });
    }

    const actorId = request.filters.actorId || "";
    const profile = actorId
      ? await this.getProfile(request.filters.tenantId, request.filters.appId, actorId)
      : {
          tenantId: request.filters.tenantId,
          appId: request.filters.appId,
          actorId: "",
          byType: {
            fact: [],
            preference: [],
            goal: [],
            project: [],
            episode: [],
            tool_outcome: [],
            instruction: [],
            profile: [],
          },
          summary: "",
          count: 0,
        };

    const lines: string[] = [];
    if (profile.summary) {
      lines.push("KNOWN ACTOR PROFILE:");
      lines.push(profile.summary);
      lines.push("");
    }

    if (selected.length > 0) {
      lines.push("RELEVANT MEMORIES:");
      for (const item of selected) {
        lines.push(`- [${item.memoryType}] ${summarizeText(item.text)}`);
      }
    }

    return {
      profileSummary: profile.summary,
      selectedMemories: selected,
      contextText: lines.join("\n").trim(),
      totalMemories: selected.length,
      processingTime: Date.now() - Date.now(), // placeholder
    };
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<{ updated: boolean }> {
    const updated = await this.provider.applyFeedback(feedback);
    return { updated: !!updated };
  }

  async compact(): Promise<MemoryCompactResult> {
    return this.provider.compact();
  }
}
