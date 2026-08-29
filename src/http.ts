import { createHash, randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import type { MemoryCoreService } from "./service.js";
import type { MemoryType } from "./types.js";

// Kept in lockstep with the MemoryType union: `satisfies` rejects unknown members and the
// assignment below fails to compile if a member is ever added without listing it here.
const MEMORY_TYPES = [
  "fact",
  "preference",
  "goal",
  "project",
  "episode",
  "tool_outcome",
  "instruction",
  "profile",
  "pattern",
  "summary",
] as const satisfies readonly MemoryType[];
type AssertNever<T extends never> = T;
type MemoryTypesAreExhaustive = AssertNever<Exclude<MemoryType, (typeof MEMORY_TYPES)[number]>>;

const memoryTypeEnum = z.enum(MEMORY_TYPES);
const identityString = z.string().min(1).max(256);
const boundedMetadataSchema = z
  .record(z.unknown())
  .refine((value) => Object.keys(value).length <= 20, "metadata may contain at most 20 keys")
  .refine((value) => JSON.stringify(value).length <= 10_000, "metadata must be at most 10000 JSON characters");

const sourceSchema = z.object({
  sourceType: identityString,
  sourceId: identityString.optional().nullable(),
  sourceSessionId: identityString.optional().nullable(),
  metadata: boundedMetadataSchema.optional(),
});

const ingestSchema = z.object({
  observations: z.array(
    z.object({
      tenantId: identityString,
      spaceId: identityString.optional(),
      appId: identityString,
      actorId: identityString,
      threadId: identityString.optional().nullable(),
      memoryType: memoryTypeEnum,
      scope: z.enum(["thread", "actor", "workspace", "app", "tenant"]).optional(),
      text: z.string().min(4).max(1000),
      summary: z.string().max(200).optional(),
      metadata: boundedMetadataSchema.optional(),
      source: sourceSchema,
      confidence: z.number().min(0).max(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      decayPolicy: z
        .object({
          kind: z.enum(["none", "time", "inactivity"]),
          ttlDays: z.number().int().positive().optional(),
        })
        .optional(),
      observedAt: z.string().datetime().optional(),
    }).superRefine((observation, ctx) => {
      if (observation.scope === "thread" && !observation.threadId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["threadId"],
          message: "thread-scoped memory requires threadId",
        });
      }
      if (observation.scope === "workspace" && !observation.spaceId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spaceId"],
          message: "workspace-scoped memory requires an explicit spaceId",
        });
      }
    }),
  ).min(1).max(200),
});

const filtersSchema = z.object({
  tenantId: identityString,
  spaceId: identityString.optional(),
  appId: identityString,
  actorId: identityString.optional(),
  accessThreadId: identityString.optional(),
  threadId: identityString.optional(),
  memoryTypes: z.array(memoryTypeEnum).optional(),
  scope: z.array(z.enum(["thread", "actor", "workspace", "app", "tenant"])).optional(),
  metadata: z.record(z.union([z.string().max(1000), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 20, "metadata may contain at most 20 keys")
    .optional(),
});

const searchSchema = z.object({
  query: z.string().min(1).max(4000),
  filters: filtersSchema,
  limit: z.number().int().positive().max(100).optional(),
  minScore: z.number().min(0).max(1).optional(),
  rerankerMinScore: z.number().min(0).max(1).optional(),
});

const contextSchema = z.object({
  query: z.string().min(1).max(4000),
  filters: filtersSchema,
  budget: z
    .object({
      maxItems: z.number().int().positive().max(30).optional(),
      maxChars: z.number().int().min(300).max(20000).optional(),
    })
    .optional(),
});

const profileQuerySchema = z.object({
  spaceId: identityString.optional(),
  threadId: identityString.optional(),
});

const idAccessSchema = z.object({
  memoryId: identityString,
  tenantId: identityString,
  spaceId: identityString.optional(),
  appId: identityString,
  actorId: identityString,
  accessThreadId: identityString.optional(),
});

const metadataPatchSchema = boundedMetadataSchema;

const retireSchema = idAccessSchema.extend({
  status: z.enum(["superseded", "archived"]),
  metadata: metadataPatchSchema.optional(),
});

// The public type stays optional for legacy in-process callers, but every HTTP
// feedback mutation carries the complete caller identity. A tenant/space pair
// alone must not mutate another actor's private record in a shared space.
const feedbackSchema = z.object({
  memoryId: identityString,
  signal: z.enum(["selected", "positive", "negative"]),
  tenantId: identityString,
  spaceId: identityString.optional(),
  appId: identityString,
  actorId: identityString,
  accessThreadId: identityString.optional(),
});

export interface PrincipalApiKey {
  key: string;
  tenantId: string;
  /** Defaults to actorId for a personal agent. */
  spaceId?: string;
  appId: string;
  actorId: string;
}

export interface HttpAppOptions {
  /** Global operator keys. These may access every tenant and run compaction. */
  apiKeys?: Set<string>;
  /** Trusted tenant-admin/identity-assertor keys. These may act as any actor in the tenant. */
  tenantApiKeys?: Map<string, Set<string>>;
  /** Normal agent credentials bound to an exact tenant/space/app/actor principal. */
  principalApiKeys?: PrincipalApiKey[];
  rateLimitPerMin?: number;
  /** Coarse IP limiter applied before auth/body parsing, excluding probes. Defaults to max(600, 10x key limit). */
  preAuthRateLimitPerMin?: number;
  /** Number of trusted reverse-proxy hops. Omit to trust no proxy headers. */
  trustProxyHops?: number;
  logger?: (line: string) => void;
}

interface RateBucket {
  windowStartMs: number;
  count: number;
}

interface ApiKeyGrant {
  global: boolean;
  tenantIds: Set<string>;
  principals: Array<Omit<PrincipalApiKey, "key"> & { spaceId: string }>;
}

interface RequestedPrincipal {
  tenantId: string;
  spaceId?: string;
  appId: string;
  actorId?: string;
}

function sendValidationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    message: "Validation error",
    errors: error.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    })),
  });
}

function parseMemoryTypes(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  return input
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function extractApiKey(req: Request): string | undefined {
  const xApiKey = req.header("x-api-key");
  if (xApiKey) return xApiKey;

  const auth = req.header("authorization");
  if (!auth) return undefined;
  const [scheme, value] = auth.split(" ", 2);
  if (!scheme || !value) return undefined;
  if (scheme.toLowerCase() !== "bearer") return undefined;
  return value;
}

function apiKeyDigest(value: string): string {
  // Fixed-width digests avoid direct variable-length secret comparison and keep
  // raw credentials out of the lookup structure used on every request.
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function buildApiKeyGrants(
  globalKeys: Set<string>,
  tenantApiKeys: Map<string, Set<string>>,
  principalApiKeys: PrincipalApiKey[],
): Map<string, ApiKeyGrant> {
  const grants = new Map<string, ApiKeyGrant>();

  for (const key of globalKeys) {
    if (!key) throw new Error("Memory-core API keys must not be empty");
    grants.set(apiKeyDigest(key), { global: true, tenantIds: new Set(), principals: [] });
  }

  for (const [tenantId, keys] of tenantApiKeys.entries()) {
    if (!tenantId) throw new Error("Memory-core tenant API key mappings require a tenant id");
    for (const key of keys) {
      if (!key) throw new Error("Memory-core API keys must not be empty");
      const digest = apiKeyDigest(key);
      const existing = grants.get(digest);
      if (existing?.global || (existing?.principals.length ?? 0) > 0) {
        // Do not identify the credential in the error.
        throw new Error("A memory-core API key cannot combine operator, tenant-admin, and principal grants");
      }
      if (existing) {
        existing.tenantIds.add(tenantId);
      } else {
        grants.set(digest, { global: false, tenantIds: new Set([tenantId]), principals: [] });
      }
    }
  }

  for (const principal of principalApiKeys) {
    const values = [principal.key, principal.tenantId, principal.appId, principal.actorId];
    if (values.some((value) => !value || value !== value.trim())) {
      throw new Error("Memory-core principal API key grants require non-empty, trimmed key/tenant/app/actor values");
    }
    const spaceId = principal.spaceId?.trim() || principal.actorId;
    if (spaceId.length > 256 || principal.tenantId.length > 256 || principal.appId.length > 256 || principal.actorId.length > 256) {
      throw new Error("Memory-core principal API key identities must be at most 256 characters");
    }
    const digest = apiKeyDigest(principal.key);
    const existing = grants.get(digest);
    if (existing?.global || (existing?.tenantIds.size ?? 0) > 0) {
      throw new Error("A memory-core API key cannot combine operator, tenant-admin, and principal grants");
    }
    const grant = existing ?? { global: false, tenantIds: new Set<string>(), principals: [] };
    grant.principals.push({
      tenantId: principal.tenantId,
      spaceId,
      appId: principal.appId,
      actorId: principal.actorId,
    });
    grants.set(digest, grant);
  }

  return grants;
}

function requestIdFrom(req: Request): string {
  const supplied = req.header("x-request-id")?.trim();
  // Keep correlation ids useful without reflecting control characters, spaces,
  // or unbounded caller input into response headers and logs.
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
}

function bodyParserErrorStatus(error: unknown): 400 | 413 | 500 {
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
  if (type === "entity.too.large") return 413;
  if (type === "entity.parse.failed") return 400;
  return 500;
}

function withAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function createRateLimiter(limitPerMin: number, useAuthenticatedKey: boolean): RequestHandler {
  const buckets = new Map<string, RateBucket>();
  const windowMs = 60_000;
  let requestsSinceSweep = 0;

  return (req: Request, res: Response, next: NextFunction) => {
    if (limitPerMin <= 0) return next();

    const apiKey = useAuthenticatedKey ? extractApiKey(req) : undefined;
    const identity = apiKey ? `key:${apiKeyDigest(apiKey)}` : `ip:${req.ip || "unknown"}`;
    const now = Date.now();
    requestsSinceSweep += 1;
    if (requestsSinceSweep >= 256) {
      for (const [key, value] of buckets.entries()) {
        if (now - value.windowStartMs >= windowMs) buckets.delete(key);
      }
      requestsSinceSweep = 0;
    }

    const bucket = buckets.get(identity);

    if (!bucket || now - bucket.windowStartMs >= windowMs) {
      if (!bucket && buckets.size >= 10_000) {
        // Map iteration is insertion ordered and a bucket's window start never
        // moves, so this is the oldest live identity. Bounded eviction avoids
        // both an O(n) scan per request and globally shedding every new client.
        const oldest = buckets.keys().next().value as string | undefined;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      buckets.set(identity, { windowStartMs: now, count: 1 });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limitPerMin) {
      const retryAfterSec = Math.ceil((windowMs - (now - bucket.windowStartMs)) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        message: "Rate limit exceeded",
        limitPerMin,
      });
    }

    return next();
  };
}

export function createMemoryCoreApp(service: MemoryCoreService, options: HttpAppOptions = {}): Express {
  const app = express();
  const apiKeys = options.apiKeys ?? new Set<string>();
  const tenantApiKeys = options.tenantApiKeys ?? new Map<string, Set<string>>();
  const principalApiKeys = options.principalApiKeys ?? [];
  const apiKeyGrants = buildApiKeyGrants(apiKeys, tenantApiKeys, principalApiKeys);
  const authEnabled = apiKeyGrants.size > 0;
  const rateLimitPerMin = options.rateLimitPerMin ?? 120;
  const preAuthRateLimitPerMin = options.preAuthRateLimitPerMin ?? Math.max(600, rateLimitPerMin * 10);
  const log = options.logger ?? console.log;

  const authorizeGlobal = (res: Response): boolean => {
    if (!authEnabled) return true;
    const grant = res.locals.memoryCoreAuthGrant as ApiKeyGrant | undefined;
    if (grant?.global) return true;
    res.status(403).json({ message: "Forbidden" });
    return false;
  };

  const authorizePrincipals = (res: Response, requested: RequestedPrincipal[]): boolean => {
    if (!authEnabled) return true;
    const grant = res.locals.memoryCoreAuthGrant as ApiKeyGrant | undefined;
    if (grant?.global) return true;
    if (grant && requested.every((identity) => grant.tenantIds.has(identity.tenantId))) return true;
    const allowed = Boolean(grant && requested.every((identity) => {
      const effectiveSpaceId = identity.spaceId?.trim() || identity.actorId?.trim();
      if (!effectiveSpaceId || !identity.actorId) return false;
      return grant.principals.some((principal) =>
        principal.tenantId === identity.tenantId &&
        principal.spaceId === effectiveSpaceId &&
        principal.appId === identity.appId &&
        principal.actorId === identity.actorId,
      );
    }));
    if (allowed) return true;
    res.status(403).json({ message: "Forbidden" });
    return false;
  };

  const authorizeObservations = (
    res: Response,
    observations: Array<RequestedPrincipal & { scope?: string }>,
  ): boolean => {
    if (!authEnabled) return true;
    const grant = res.locals.memoryCoreAuthGrant as ApiKeyGrant | undefined;
    if (grant?.global || (grant && observations.every((obs) => grant.tenantIds.has(obs.tenantId)))) return true;
    // A principal credential may share within its configured space, but only a
    // tenant administrator may publish evidence across every space.
    if (observations.some((observation) => observation.scope === "tenant")) {
      res.status(403).json({ message: "Forbidden" });
      return false;
    }
    return authorizePrincipals(res, observations);
  };

  app.disable("x-powered-by");
  if (options.trustProxyHops !== undefined) app.set("trust proxy", options.trustProxyHops);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = requestIdFrom(req);
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");

    res.on("finish", () => {
      const ms = Date.now() - startedAt;
      // originalUrl contains the GET search query, which can itself be sensitive
      // memory content. Log only the path.
      log(`[memory-core] ${requestId} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });

    next();
  });
  app.get("/health", withAsync(async (_req: Request, res: Response) => {
    res.json({ ok: true, service: "memory-core", timestamp: new Date().toISOString() });
  }));

  app.get("/ready", withAsync(async (_req: Request, res: Response) => {
    const providerHealth = await service.getHealth();
    // These unauthenticated endpoints are for orchestrators, not diagnostics.
    // Do not expose server versions, model ids, row counts, or upstream errors.
    const provider = {
      ok: providerHealth.ok,
      provider: providerHealth.provider,
    };
    if (!providerHealth.ok) {
      return res.status(503).json({
        ok: false,
        provider,
      });
    }

    return res.json({
      ok: true,
      service: "memory-core",
      provider,
      timestamp: new Date().toISOString(),
    });
  }));

  // Coarse IP protection runs before auth and JSON parsing, so invalid keys and
  // oversized bodies cannot bypass all request accounting. Orchestrator probes
  // above are deliberately exempt from admission-control state.
  app.use(createRateLimiter(preAuthRateLimitPerMin, false));

  app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
    if (!authEnabled) return next();
    const apiKey = extractApiKey(req);
    const grant = apiKey ? apiKeyGrants.get(apiKeyDigest(apiKey)) : undefined;
    if (grant) {
      res.locals.memoryCoreAuthGrant = grant;
      return next();
    }
    return res.status(401).json({ message: "Unauthorized" });
  });

  // After the coarse IP gate, valid credentials receive a separate per-key
  // quota. Readiness/liveness probes do not consume tenant request capacity.
  app.use("/v1", createRateLimiter(rateLimitPerMin, authEnabled));

  // Parse only authenticated/rate-limited API requests. Health endpoints never
  // accept request bodies and therefore do not pay the JSON parsing cost.
  app.use("/v1", express.json({ limit: "2mb" }));

  app.post("/v1/memory/ingest", withAsync(async (req: Request, res: Response) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizeObservations(res, parsed.data.observations)) return;
    const result = await service.ingest(parsed.data);
    return res.json(result);
  }));

  app.post("/v1/memory/search", withAsync(async (req: Request, res: Response) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizePrincipals(res, [parsed.data.filters])) return;
    const result = await service.search(parsed.data);
    return res.json({ count: result.length, hits: result });
  }));

  app.post("/v1/memory/context", withAsync(async (req: Request, res: Response) => {
    const parsed = contextSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizePrincipals(res, [parsed.data.filters])) return;
    const result = await service.buildContext(parsed.data);
    return res.json(result);
  }));

  app.post("/v1/memory/get", withAsync(async (req: Request, res: Response) => {
    const parsed = idAccessSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizePrincipals(res, [parsed.data])) return;
    const { memoryId, ...scope } = parsed.data;
    const memory = await service.getMemory(memoryId, scope);
    return res.json({ memory });
  }));

  app.post("/v1/memory/status", withAsync(async (req: Request, res: Response) => {
    const parsed = retireSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizePrincipals(res, [parsed.data])) return;
    const { memoryId, status, metadata, ...scope } = parsed.data;
    const result = await service.retireMemory(memoryId, status, metadata, scope);
    return res.json(result);
  }));

  app.get(
    "/v1/memory/profile/:tenantId/:appId/:actorId",
    withAsync(async (req: Request, res: Response) => {
      const tenantId = String(req.params.tenantId || "");
      const appId = String(req.params.appId || "");
      const actorId = String(req.params.actorId || "");
      if (!tenantId || !appId || !actorId) {
        return res.status(400).json({ message: "Missing required route params" });
      }
      const routeIdentity = z.object({ tenantId: identityString, appId: identityString, actorId: identityString }).safeParse({
        tenantId,
        appId,
        actorId,
      });
      if (!routeIdentity.success) return sendValidationError(res, routeIdentity.error);
      const queryIdentity = profileQuerySchema.safeParse({
        spaceId: firstQueryValue(req.query.spaceId),
        threadId: firstQueryValue(req.query.threadId),
      });
      if (!queryIdentity.success) return sendValidationError(res, queryIdentity.error);
      const { spaceId, threadId } = queryIdentity.data;
      if (!authorizePrincipals(res, [{ ...routeIdentity.data, spaceId }])) return;
      const result = await service.getProfile(tenantId, appId, actorId, {
        spaceId,
        threadId,
      });
      return res.json(result);
    }),
  );

  app.post("/v1/memory/feedback", withAsync(async (req: Request, res: Response) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizePrincipals(res, [parsed.data])) return;
    const result = await service.applyFeedback(parsed.data);
    return res.json(result);
  }));

  app.post("/v1/memory/compact", withAsync(async (_req: Request, res: Response) => {
    if (!authorizeGlobal(res)) return;
    const result = await service.compact();
    return res.json(result);
  }));

  app.get("/v1/memory/search", withAsync(async (req: Request, res: Response) => {
    const query = firstQueryValue(req.query.q) ?? "";
    const tenantId = firstQueryValue(req.query.tenantId) ?? "";
    const appId = firstQueryValue(req.query.appId) ?? "";
    const spaceId = firstQueryValue(req.query.spaceId);
    const actorId = firstQueryValue(req.query.actorId);
    const accessThreadId = firstQueryValue(req.query.accessThreadId);
    const threadId = firstQueryValue(req.query.threadId);
    const limitRaw = firstQueryValue(req.query.limit);
    const minScoreRaw = firstQueryValue(req.query.minScore);
    const rerankerMinScoreRaw = firstQueryValue(req.query.rerankerMinScore);
    const typesRaw = firstQueryValue(req.query.types);
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const minScore = minScoreRaw ? Number(minScoreRaw) : undefined;
    const rerankerMinScore = rerankerMinScoreRaw ? Number(rerankerMinScoreRaw) : undefined;
    const memoryTypes = parseMemoryTypes(typesRaw);

    const parsed = searchSchema.safeParse({
      query,
      filters: {
        tenantId,
        spaceId,
        appId,
        actorId,
        accessThreadId,
        threadId,
        memoryTypes,
      },
      limit,
      minScore,
      rerankerMinScore,
    });

    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (!authorizePrincipals(res, [parsed.data.filters])) return;
    const result = await service.search(parsed.data);
    return res.json({ count: result.length, hits: result });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = bodyParserErrorStatus(err);
    const message = status >= 500
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Bad request";
    res.status(status).json({ message });
  });

  return app;
}
