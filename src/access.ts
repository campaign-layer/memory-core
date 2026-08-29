import type { MemoryFilters, MemoryObservation, MemoryRecord, MemoryScope } from "./types.js";
import type { MemoryIdScope } from "./provider.js";
import { normalizeKey } from "./utils.js";

type SpaceInput = Pick<MemoryObservation, "tenantId" | "spaceId" | "appId" | "actorId">;

/**
 * Personal agents share memory across producer apps by default. A team or other
 * shared installation supplies an explicit spaceId instead.
 */
export function resolveSpaceId(input: SpaceInput): string {
  const explicit = input.spaceId?.trim();
  if (explicit) return explicit;
  const actor = input.actorId?.trim();
  if (actor) return actor;
  const app = input.appId?.trim();
  if (app) return app;
  throw new Error("memory access requires spaceId, actorId, or appId");
}

/** Old file snapshots have no spaceId; they migrate into the actor's personal space. */
export function recordSpaceId(record: Pick<MemoryRecord, "spaceId" | "actorId" | "appId" | "tenantId">): string {
  return resolveSpaceId(record);
}

export function normalizeRecordSpace(record: MemoryRecord): MemoryRecord {
  const spaceId = recordSpaceId(record);
  return record.spaceId === spaceId ? record : { ...record, spaceId };
}

export function accessSpaceId(filters: MemoryFilters): string {
  return resolveSpaceId({
    tenantId: filters.tenantId,
    spaceId: filters.spaceId,
    appId: filters.appId,
    actorId: filters.actorId ?? "",
  });
}

export function requireMemoryAccess(filters: MemoryFilters | undefined): MemoryFilters {
  if (!filters?.tenantId || !filters?.appId) {
    throw new Error("MemoryFilters.tenantId and MemoryFilters.appId are required");
  }
  accessSpaceId(filters);
  return filters;
}

/**
 * Visibility policy shared by every in-process provider.
 *
 * tenant    all spaces in the tenant
 * workspace every actor/app in one space
 * app       one producer app in one space
 * actor     one actor across producer apps in one space
 * thread    one actor and one thread in one space
 */
export function memoryVisibleTo(record: MemoryRecord, filters: MemoryFilters): boolean {
  if (record.tenantId !== filters.tenantId) return false;

  if (record.scope !== "tenant" && recordSpaceId(record) !== accessSpaceId(filters)) return false;

  switch (record.scope) {
    case "tenant":
    case "workspace":
      break;
    case "app":
      if (record.appId !== filters.appId) return false;
      break;
    case "actor":
      if (!filters.actorId || record.actorId !== filters.actorId) return false;
      break;
    case "thread":
      if (!filters.actorId || record.actorId !== filters.actorId) return false;
      if (!(filters.accessThreadId ?? filters.threadId) || record.threadId !== (filters.accessThreadId ?? filters.threadId)) return false;
      break;
  }

  if (filters.memoryTypes?.length && !filters.memoryTypes.includes(record.memoryType)) return false;
  if (filters.scope?.length && !filters.scope.includes(record.scope)) return false;
  if (filters.threadId && record.threadId !== filters.threadId) return false;
  if (filters.metadata) {
    for (const [key, value] of Object.entries(filters.metadata)) {
      if (record.metadata[key] !== value) return false;
    }
  }
  return true;
}

/**
 * Authorization for operations addressed by an opaque memory id.
 *
 * A space id alone is not sufficient: actor and thread memories remain private
 * inside a shared workspace. Non-tenant records always require a space (or an
 * actor whose personal-space default supplies it); an app id alone must never
 * become an app-wide cross-space capability.
 */
export function memoryVisibleToIdScope(record: MemoryRecord, scope: MemoryIdScope): boolean {
  if (record.tenantId !== scope.tenantId) return false;

  const spaceId = scope.spaceId?.trim() || scope.actorId?.trim();
  if (record.scope !== "tenant" && (!spaceId || recordSpaceId(record) !== spaceId)) return false;

  switch (record.scope) {
    case "tenant":
    case "workspace":
      return true;
    case "app":
      return Boolean(scope.appId && record.appId === scope.appId);
    case "actor":
      return Boolean(scope.actorId && record.actorId === scope.actorId);
    case "thread":
      return Boolean(
        scope.actorId &&
        record.actorId === scope.actorId &&
        scope.accessThreadId &&
        record.threadId === scope.accessThreadId
      );
  }
}

export function validateObservationScope(observation: MemoryObservation): void {
  if (observation.scope === "thread" && !observation.threadId) {
    throw new Error("thread-scoped memory requires threadId");
  }
  if (observation.scope === "workspace" && !observation.spaceId?.trim()) {
    throw new Error("workspace-scoped memory requires an explicit spaceId");
  }
}

/** The visibility locus is part of identity: equal text in two scopes is not a duplicate. */
export function memoryVisibilityKey(
  record: Pick<MemoryRecord, "tenantId" | "spaceId" | "appId" | "actorId" | "threadId" | "scope">,
): string {
  const spaceId = recordSpaceId(record as MemoryRecord);
  const parts: Array<string | null> = [record.tenantId, record.scope];
  switch (record.scope) {
    case "tenant":
      break;
    case "workspace":
      parts.push(spaceId);
      break;
    case "app":
      parts.push(spaceId, record.appId);
      break;
    case "actor":
      parts.push(spaceId, record.actorId);
      break;
    case "thread":
      parts.push(spaceId, record.actorId, record.threadId ?? null);
      break;
  }
  return JSON.stringify(parts);
}

export function memoryDedupeKey(
  record: Pick<MemoryRecord, "tenantId" | "spaceId" | "appId" | "actorId" | "threadId" | "scope" | "memoryType" | "text">,
): string {
  return JSON.stringify([memoryVisibilityKey(record), record.memoryType, normalizeKey(record.text)]);
}

/** An opaque id may update content, never move to another security principal. */
export function sameMemoryOwner(
  existing: Pick<MemoryRecord, "tenantId" | "spaceId" | "appId" | "actorId" | "scope" | "threadId">,
  incoming: Pick<MemoryRecord, "tenantId" | "spaceId" | "appId" | "actorId" | "scope" | "threadId">,
): boolean {
  return existing.tenantId === incoming.tenantId &&
    recordSpaceId(existing as MemoryRecord) === recordSpaceId(incoming as MemoryRecord) &&
    existing.appId === incoming.appId &&
    existing.actorId === incoming.actorId &&
    existing.scope === incoming.scope &&
    (existing.threadId ?? null) === (incoming.threadId ?? null);
}

export function scopeVisibilityDescription(scope: MemoryScope): string {
  switch (scope) {
    case "thread": return "current actor and thread";
    case "actor": return "current actor across apps";
    case "workspace": return "every actor and app in the memory space";
    case "app": return "current producer app in the memory space";
    case "tenant": return "every memory space in the tenant";
  }
}
