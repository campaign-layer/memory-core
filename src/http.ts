import { randomUUID } from "node:crypto";
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

const memoryTypeEnum = z.enum([
  "fact",
  "preference",
  "goal",
  "project",
  "episode",
  "tool_outcome",
  "instruction",
  "profile",
]);

const sourceSchema = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().optional(),
  sourceSessionId: z.string().optional(),
});

const ingestSchema = z.object({
  observations: z.array(
    z.object({
      tenantId: z.string().min(1),
      appId: z.string().min(1),
      actorId: z.string().min(1),
      threadId: z.string().optional().nullable(),
      memoryType: memoryTypeEnum,
      scope: z.enum(["thread", "actor", "workspace", "app", "tenant"]).optional(),
      text: z.string().min(4),
      summary: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
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
    }),
  ).min(1),
});

const filtersSchema = z.object({
  tenantId: z.string().min(1),
  appId: z.string().min(1),
  actorId: z.string().optional(),
  threadId: z.string().optional(),
  memoryTypes: z.array(memoryTypeEnum).optional(),
  scope: z.array(z.enum(["thread", "actor", "workspace", "app", "tenant"])).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  filters: filtersSchema,
  limit: z.number().int().positive().max(100).optional(),
  minScore: z.number().min(0).max(1).optional(),
});

const contextSchema = z.object({
  query: z.string().min(1),
  filters: filtersSchema,
  budget: z
    .object({
      maxItems: z.number().int().positive().max(30).optional(),
      maxChars: z.number().int().positive().max(20000).optional(),
    })
    .optional(),
});

const feedbackSchema = z.object({
  memoryId: z.string().min(1),
  signal: z.enum(["selected", "positive", "negative"]),
});

interface HttpAppOptions {
  apiKeys?: Set<string>;
  rateLimitPerMin?: number;
  logger?: (line: string) => void;
}

interface RateBucket {
  windowStartMs: number;
  count: number;
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

function parseMemoryTypes(input: string | undefined): MemoryType[] | undefined {
  if (!input) return undefined;
  const values = input
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const parsed = z.array(memoryTypeEnum).safeParse(values);
  return parsed.success ? parsed.data : undefined;
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

function withAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function createRateLimiter(limitPerMin: number): RequestHandler {
  const buckets = new Map<string, RateBucket>();
  const windowMs = 60_000;

  return (req: Request, res: Response, next: NextFunction) => {
    if (limitPerMin <= 0) return next();

    const identity = extractApiKey(req) || req.ip || "unknown";
    const now = Date.now();
    const bucket = buckets.get(identity);

    if (!bucket || now - bucket.windowStartMs >= windowMs) {
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

    if (buckets.size > 10_000) {
      for (const [key, value] of buckets.entries()) {
        if (now - value.windowStartMs > windowMs * 2) buckets.delete(key);
      }
    }

    return next();
  };
}

export function createMemoryCoreApp(service: MemoryCoreService, options: HttpAppOptions = {}): Express {
  const app = express();
  const apiKeys = options.apiKeys ?? new Set<string>();
  const rateLimitPerMin = options.rateLimitPerMin ?? 120;
  const log = options.logger ?? console.log;

  app.use(express.json({ limit: "2mb" }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.header("x-request-id") || randomUUID();
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);

    res.on("finish", () => {
      const ms = Date.now() - startedAt;
      log(`[memory-core] ${requestId} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });

    next();
  });

  app.use(createRateLimiter(rateLimitPerMin));

  app.get("/health", withAsync(async (_req: Request, res: Response) => {
    res.json({ ok: true, service: "memory-core", timestamp: new Date().toISOString() });
  }));

  app.get("/ready", withAsync(async (_req: Request, res: Response) => {
    const providerHealth = await service.getHealth();
    if (!providerHealth.ok) {
      return res.status(503).json({
        ok: false,
        provider: providerHealth,
      });
    }

    return res.json({
      ok: true,
      service: "memory-core",
      provider: providerHealth,
      timestamp: new Date().toISOString(),
    });
  }));

  app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
    if (apiKeys.size === 0) return next();
    const apiKey = extractApiKey(req);
    if (apiKey && apiKeys.has(apiKey)) return next();
    return res.status(401).json({ message: "Unauthorized" });
  });

  app.post("/v1/memory/ingest", withAsync(async (req: Request, res: Response) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const result = await service.ingest(parsed.data);
    return res.json(result);
  }));

  app.post("/v1/memory/search", withAsync(async (req: Request, res: Response) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const result = await service.search(parsed.data);
    return res.json({ count: result.length, hits: result });
  }));

  app.post("/v1/memory/context", withAsync(async (req: Request, res: Response) => {
    const parsed = contextSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const result = await service.buildContext(parsed.data);
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
      const result = await service.getProfile(tenantId, appId, actorId);
      return res.json(result);
    }),
  );

  app.post("/v1/memory/feedback", withAsync(async (req: Request, res: Response) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const result = await service.applyFeedback(parsed.data);
    return res.json(result);
  }));

  app.post("/v1/memory/compact", withAsync(async (_req: Request, res: Response) => {
    const result = await service.compact();
    return res.json(result);
  }));

  app.get("/v1/memory/search", withAsync(async (req: Request, res: Response) => {
    const query = firstQueryValue(req.query.q) ?? "";
    const tenantId = firstQueryValue(req.query.tenantId) ?? "";
    const appId = firstQueryValue(req.query.appId) ?? "";
    const actorId = firstQueryValue(req.query.actorId);
    const threadId = firstQueryValue(req.query.threadId);
    const limitRaw = firstQueryValue(req.query.limit);
    const minScoreRaw = firstQueryValue(req.query.minScore);
    const typesRaw = firstQueryValue(req.query.types);
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const minScore = minScoreRaw ? Number(minScoreRaw) : undefined;
    const memoryTypes = parseMemoryTypes(typesRaw);

    const parsed = searchSchema.safeParse({
      query,
      filters: {
        tenantId,
        appId,
        actorId,
        threadId,
        memoryTypes,
      },
      limit,
      minScore,
    });

    if (!parsed.success) return sendValidationError(res, parsed.error);
    const result = await service.search(parsed.data);
    return res.json({ count: result.length, hits: result });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unexpected error";
    res.status(500).json({ message });
  });

  return app;
}
