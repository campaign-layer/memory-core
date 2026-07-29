import { z } from "zod";
import type { MemoryCoreService } from "../service.js";
import type { MemoryIdScope, MemoryProvider } from "../provider.js";
import type { MemoryCoreClient } from "../client.js";
import type {
  ContextBuildRequest,
  ContextBuildResult,
  MemoryFeedbackInput,
  MemoryObservation,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryStatus,
  MemoryType,
} from "../types.js";

// Canonical agent-facing memory tools. Every runtime adapter (MCP, Anthropic,
// OpenAI, custom) is generated from the definitions in this file.

export const MEMORY_TOOL_NAMES = [
  "remember",
  "recall",
  "build_context",
  "forget",
  "supersede",
  "feedback",
] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

/** Memory types worth exposing to a model. `pattern`/`summary` are system-derived. */
const agentMemoryType = z.enum([
  "fact",
  "preference",
  "goal",
  "project",
  "episode",
  "instruction",
  "tool_outcome",
]);

const agentScope = z.enum(["thread", "actor", "workspace"]);

const feedbackSignal = z.enum(["used", "useful", "not_useful"]);

const SIGNAL_MAP: Record<z.infer<typeof feedbackSignal>, MemoryFeedbackInput["signal"]> = {
  used: "selected",
  useful: "positive",
  not_useful: "negative",
};

export const rememberShape = {
  text: z
    .string()
    .min(4)
    .max(1000)
    .describe("The fact, stated so it stands alone with no surrounding context."),
  type: agentMemoryType
    .default("fact")
    .describe(
      "fact=stable truth, preference=how they like things done, goal=what they are trying to achieve, project=repo/system detail, instruction=standing order to follow, tool_outcome=result worth not rediscovering, episode=notable event.",
    ),
  importance: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("0.9 for load-bearing constraints, 0.5 default, 0.2 for trivia."),
  scope: agentScope
    .default("actor")
    .describe("actor=remember across all sessions (default), thread=this conversation only, workspace=shared with the team."),
};

export const recallShape = {
  query: z.string().min(2).max(500).describe("What you want to know, in plain words."),
  limit: z.number().int().min(1).max(20).default(6).describe("Max memories to return."),
  types: z
    .array(agentMemoryType)
    .min(1)
    .max(7)
    .optional()
    .describe("Restrict to these memory types. Omit to search everything."),
};

export const buildContextShape = {
  query: z.string().min(2).max(500).describe("The user's current request or topic."),
  maxItems: z.number().int().min(1).max(30).default(8).describe("Max memories in the block."),
  maxChars: z.number().int().min(300).max(20000).default(3000).describe("Hard character budget."),
};

export const forgetShape = {
  memoryId: z.string().min(1).describe("id from a previous recall or build_context result."),
  reason: z.string().max(200).optional().describe("Why it is wrong. Short."),
};

export const supersedeShape = {
  memoryId: z.string().min(1).describe("id of the outdated memory, from recall."),
  newText: z.string().min(4).max(1000).describe("The current value, stated so it stands alone."),
  reason: z.string().max(200).optional().describe("What changed. Short."),
};

export const feedbackShape = {
  memoryId: z.string().min(1).describe("id from a previous recall or build_context result."),
  signal: feedbackSignal.describe("used=you put it in your answer, useful=correct and relevant, not_useful=irrelevant or misleading."),
};

export interface MemoryToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: MemoryToolName;
  title: string;
  description: string;
  /** Raw zod shape - the MCP SDK wants this form. */
  shape: Shape;
  /** Same schema as an object, for direct validation. */
  schema: z.ZodObject<Shape>;
  readOnly: boolean;
}

function define<Shape extends z.ZodRawShape>(
  name: MemoryToolName,
  title: string,
  readOnly: boolean,
  shape: Shape,
  description: string,
): MemoryToolDefinition<Shape> {
  return { name, title, readOnly, shape, schema: z.object(shape), description };
}

export const MEMORY_TOOLS = [
  define(
    "remember",
    "Remember a durable fact",
    false,
    rememberShape,
    [
      "Store something in long-term memory that will still matter in a future, unrelated session.",
      "Call it the moment you learn it: stated preferences, decisions and their reasons, constraints, role/identity, project and repo layout, standing instructions, expensive tool results.",
      "Do NOT store: transient chatter, anything already in the current prompt, your own reasoning, secrets, credentials, or a guess you have not confirmed.",
      "One fact per call. Write it so it makes sense with zero context: 'Alex deploys with pnpm, never npm', not 'they prefer that'.",
      "Exact duplicates are merged server-side, so calling when unsure is cheap.",
    ].join(" "),
  ),
  define(
    "recall",
    "Recall memories",
    true,
    recallShape,
    [
      "Search long-term memory before you answer, guess, or ask the user to repeat themselves.",
      "Use it whenever the answer could depend on earlier sessions - preferences, past decisions, project details, or any 'as I mentioned' reference.",
      "Query with the topic in plain words, not keywords.",
      "Returns ranked memories with an id, score, and why each matched; pass those ids to feedback, forget, or supersede.",
      "An empty result means nothing is stored: say so instead of inventing a memory.",
    ].join(" "),
  ),
  define(
    "build_context",
    "Build a memory context block",
    true,
    buildContextShape,
    [
      "Return one token-budgeted memory block, ready to paste into your system prompt before you generate.",
      "Prefer this over recall at the start of a turn: it merges the actor's profile with the memories most relevant to the request and trims to a character budget.",
      "Use recall instead when you need individual ids and scores to act on.",
    ].join(" "),
  ),
  define(
    "forget",
    "Forget a wrong memory",
    false,
    forgetShape,
    [
      "Mark a stored memory as wrong so it stops being recalled.",
      "Use when the user contradicts or corrects something memory returned and there is no replacement value.",
      "Needs the memory id from recall or build_context. If you know the new value, call supersede instead - do not forget then remember.",
    ].join(" "),
  ),
  define(
    "supersede",
    "Replace an outdated memory",
    false,
    supersedeShape,
    [
      "Replace an outdated memory with its current value in one step: the old memory stops being recalled and the new text is stored in its place, keeping the original type and scope.",
      "Use when a fact changed rather than was never true - moved city, switched framework, new title, revised deadline.",
      "Needs the old memory id from recall.",
    ].join(" "),
  ),
  define(
    "feedback",
    "Rate a recalled memory",
    false,
    feedbackShape,
    [
      "Report whether a recalled memory actually helped, so ranking improves for next time.",
      "Fire-and-forget and cheap; send it right after you use or discard a recall result.",
      "This only adjusts ranking - to fix a wrong fact use forget or supersede.",
    ].join(" "),
  ),
] as const satisfies ReadonlyArray<MemoryToolDefinition<any>>;

export function getMemoryTool(name: string): MemoryToolDefinition<any> | undefined {
  return MEMORY_TOOLS.find((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

export interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaNode;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
}

// Hand-rolled on purpose: zod-to-json-schema is only present as a transitive
// dep of the MCP SDK, and these schemas use a small, closed set of zod nodes.
function nodeToJsonSchema(schema: z.ZodTypeAny): { node: JsonSchemaNode; required: boolean } {
  const def = schema._def as { typeName: string; [key: string]: any };
  const description = schema.description;

  const withDescription = (node: JsonSchemaNode): JsonSchemaNode =>
    description ? { description, ...node } : node;

  switch (def.typeName) {
    case "ZodOptional": {
      const inner = nodeToJsonSchema(def.innerType);
      return { node: description ? { description, ...inner.node } : inner.node, required: false };
    }
    case "ZodDefault": {
      const inner = nodeToJsonSchema(def.innerType);
      const node: JsonSchemaNode = { ...inner.node, default: def.defaultValue() };
      return { node: description ? { description, ...node } : node, required: false };
    }
    case "ZodString": {
      const node: JsonSchemaNode = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") node.minLength = check.value;
        if (check.kind === "max") node.maxLength = check.value;
      }
      return { node: withDescription(node), required: true };
    }
    case "ZodNumber": {
      const checks = def.checks ?? [];
      const isInt = checks.some((c: any) => c.kind === "int");
      const node: JsonSchemaNode = { type: isInt ? "integer" : "number" };
      for (const check of checks) {
        if (check.kind === "min") node.minimum = check.value;
        if (check.kind === "max") node.maximum = check.value;
      }
      return { node: withDescription(node), required: true };
    }
    case "ZodBoolean":
      return { node: withDescription({ type: "boolean" }), required: true };
    case "ZodEnum":
      return { node: withDescription({ type: "string", enum: [...def.values] }), required: true };
    case "ZodArray": {
      const node: JsonSchemaNode = { type: "array", items: nodeToJsonSchema(def.type).node };
      if (def.minLength) node.minItems = def.minLength.value;
      if (def.maxLength) node.maxItems = def.maxLength.value;
      return { node: withDescription(node), required: true };
    }
    default:
      throw new Error(`toJsonSchema: unsupported zod node ${def.typeName}`);
  }
}

export function shapeToJsonSchema(shape: z.ZodRawShape): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const converted = nodeToJsonSchema(value as z.ZodTypeAny);
    properties[key] = converted.node;
    if (converted.required) required.push(key);
  }

  return { type: "object", properties, required, additionalProperties: false };
}

/** JSON Schema for every tool, keyed by tool name. */
export function toJsonSchema(): Record<MemoryToolName, JsonSchemaNode> {
  const out = {} as Record<MemoryToolName, JsonSchemaNode>;
  for (const tool of MEMORY_TOOLS) out[tool.name] = shapeToJsonSchema(tool.shape);
  return out;
}

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchemaNode;
}

/** Anthropic Messages API `tools` array. */
export function toAnthropicTools(): AnthropicToolSpec[] {
  return MEMORY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: shapeToJsonSchema(tool.shape),
  }));
}

export interface OpenAIToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaNode;
  };
}

/** OpenAI / OpenAI-compatible chat completions `tools` array. */
export function toOpenAITools(): OpenAIToolSpec[] {
  return MEMORY_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: shapeToJsonSchema(tool.shape),
    },
  }));
}

// ---------------------------------------------------------------------------
// Backends: embedded (own provider) or remote (existing HTTP service)
// ---------------------------------------------------------------------------

export interface MemoryBackend {
  readonly kind: "embedded" | "remote";
  ingest(observations: MemoryObservation[]): Promise<{ created: number; updated: number; ids: string[] }>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  buildContext(request: ContextBuildRequest): Promise<ContextBuildResult>;
  applyFeedback(input: MemoryFeedbackInput): Promise<{ updated: boolean }>;
  // memoryId on these is model-supplied, so `scope` is required, not optional:
  // ids are globally unique and an agent must not reach another tenant's record.
  /** Only backends with direct provider access can read a single record. */
  getById?(memoryId: string, scope: MemoryIdScope): Promise<MemoryRecord | null>;
  /** Only backends with direct provider access can retire a record. */
  retire?(
    memoryId: string,
    status: MemoryStatus,
    patch: Record<string, unknown> | undefined,
    scope: MemoryIdScope,
  ): Promise<boolean>;
}

/**
 * In-process backend. Pass the provider too if you want forget/supersede to
 * actually retire records rather than only downrank them.
 */
export function createEmbeddedBackend(
  service: MemoryCoreService,
  provider?: MemoryProvider,
): MemoryBackend {
  const backend: MemoryBackend = {
    kind: "embedded",
    async ingest(observations) {
      const result = await service.ingest({ observations });
      return {
        created: result.created,
        updated: result.updated,
        ids: result.records.map((record) => record.id),
      };
    },
    search: (query) => service.search(query),
    buildContext: (request) => service.buildContext(request),
    applyFeedback: (input) => service.applyFeedback(input),
  };

  if (!provider) return backend;

  return {
    ...backend,
    getById: (memoryId, scope) => provider.getById(memoryId, scope),
    async retire(memoryId, status, patch, scope) {
      // Scoped read, so retire cannot reach across tenants: an unscoped read
      // followed by an update under our own tenant would pass the tenant guard.
      const record = await provider.getById(memoryId, scope);
      if (!record) return false;
      await provider.update({
        ...record,
        status,
        metadata: { ...record.metadata, ...(patch ?? {}) },
        updatedAt: new Date().toISOString(),
      });
      return true;
    },
  };
}

type RemoteClient = Pick<
  MemoryCoreClient,
  "ingest" | "search" | "buildContext" | "applyFeedback"
>;

/**
 * Talks to a running memory-core HTTP service. The REST surface has no
 * status endpoint, so forget/supersede downrank instead of archiving.
 */
export function createRemoteBackend(client: RemoteClient): MemoryBackend {
  return {
    kind: "remote",
    async ingest(observations) {
      const result = await client.ingest({ observations });
      const ids = (result.records as Array<{ id?: string }> | undefined)
        ?.map((record) => record?.id)
        .filter((id): id is string => typeof id === "string");
      return { created: result.created, updated: result.updated, ids: ids ?? [] };
    },
    async search(query) {
      const result = await client.search(query);
      return result.hits;
    },
    buildContext: (request) => client.buildContext(request),
    applyFeedback: (input) => client.applyFeedback(input),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface MemoryIdentity {
  tenantId: string;
  appId: string;
  actorId: string;
  threadId?: string;
}

export interface MemoryToolContext {
  backend: MemoryBackend;
  /** Never model-supplied. Comes from server config or the calling app. */
  identity: MemoryIdentity;
  sourceType?: string;
  sourceId?: string;
  /** Metadata stamped on every write from this context. */
  metadata?: Record<string, unknown>;
}

export interface MemoryToolResult {
  ok: boolean;
  /** What the model sees. Kept short on purpose. */
  text: string;
  data?: unknown;
}

const IDENTITY_HELP =
  "memory-core tools need an explicit tenantId, appId and actorId so writes cannot land in the wrong tenant.";

export function assertIdentity(identity: Partial<MemoryIdentity> | undefined): MemoryIdentity {
  const missing = (["tenantId", "appId", "actorId"] as const).filter(
    (key) => !identity?.[key] || String(identity[key]).trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(`Missing memory identity: ${missing.join(", ")}. ${IDENTITY_HELP}`);
  }
  return {
    tenantId: identity!.tenantId!.trim(),
    appId: identity!.appId!.trim(),
    actorId: identity!.actorId!.trim(),
    threadId: identity!.threadId?.trim() || undefined,
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function filtersFor(identity: MemoryIdentity, scoped: boolean, types?: MemoryType[]) {
  return {
    tenantId: identity.tenantId,
    appId: identity.appId,
    actorId: identity.actorId,
    threadId: scoped ? identity.threadId : undefined,
    memoryTypes: types,
  };
}

function observationFor(
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
  input: { text: string; memoryType: MemoryType; scope: MemoryScope; importance: number },
  extraMetadata?: Record<string, unknown>,
): MemoryObservation {
  return {
    tenantId: identity.tenantId,
    appId: identity.appId,
    actorId: identity.actorId,
    threadId: identity.threadId ?? null,
    memoryType: input.memoryType,
    scope: input.scope,
    text: input.text,
    importance: input.importance,
    metadata: { ...(ctx.metadata ?? {}), ...(extraMetadata ?? {}) },
    source: {
      sourceType: ctx.sourceType || "agent-tool",
      sourceId: ctx.sourceId ?? null,
      sourceSessionId: identity.threadId ?? null,
    },
  };
}

function formatHits(hits: MemorySearchHit[], header: string): string {
  if (hits.length === 0) return "No memories stored for this actor yet.";
  const lines = [header];
  hits.forEach((hit, index) => {
    const reasons = hit.reasons.length > 0 ? ` (${hit.reasons.join("; ")})` : "";
    lines.push(
      `${index + 1}. [${hit.memory.memoryType}] ${truncate(hit.memory.text, 180)} — score ${hit.score.toFixed(2)}${reasons} — id=${hit.memory.id}`,
    );
  });
  return lines.join("\n");
}

/** Validates args with zod and runs the tool. Bad args come back as ok:false, not a throw. */
export async function dispatch(
  name: string,
  args: unknown,
  ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
  const tool = getMemoryTool(name);
  if (!tool) {
    return {
      ok: false,
      text: `Unknown memory tool "${name}". Available: ${MEMORY_TOOL_NAMES.join(", ")}.`,
    };
  }

  // Identity is a config error, not a model error - fail loudly.
  const identity = assertIdentity(ctx.identity);

  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, text: `Invalid arguments for ${name}: ${issues}` };
  }

  switch (tool.name) {
    case "remember":
      return remember(parsed.data as RememberArgs, ctx, identity);
    case "recall":
      return recall(parsed.data as RecallArgs, ctx, identity);
    case "build_context":
      return buildContext(parsed.data as BuildContextArgs, ctx, identity);
    case "forget":
      return forget(parsed.data as ForgetArgs, ctx, identity);
    case "supersede":
      return supersede(parsed.data as SupersedeArgs, ctx, identity);
    case "feedback":
      return feedback(parsed.data as FeedbackArgs, ctx, identity);
  }
}

type RememberArgs = z.infer<z.ZodObject<typeof rememberShape>>;
type RecallArgs = z.infer<z.ZodObject<typeof recallShape>>;
type BuildContextArgs = z.infer<z.ZodObject<typeof buildContextShape>>;
type ForgetArgs = z.infer<z.ZodObject<typeof forgetShape>>;
type SupersedeArgs = z.infer<z.ZodObject<typeof supersedeShape>>;
type FeedbackArgs = z.infer<z.ZodObject<typeof feedbackShape>>;

async function remember(
  args: RememberArgs,
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
): Promise<MemoryToolResult> {
  const observation = observationFor(ctx, identity, {
    text: args.text,
    memoryType: args.type,
    scope: args.scope,
    importance: args.importance,
  });
  const result = await ctx.backend.ingest([observation]);
  const id = result.ids[0];
  const verb = result.created > 0 ? "Stored" : "Already known, refreshed";
  return {
    ok: true,
    text: `${verb} [${args.type}] ${truncate(args.text, 120)}${id ? ` — id=${id}` : ""}`,
    data: { id, created: result.created, updated: result.updated },
  };
}

async function recall(
  args: RecallArgs,
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
): Promise<MemoryToolResult> {
  const hits = await ctx.backend.search({
    query: args.query,
    filters: filtersFor(identity, false, args.types),
    limit: args.limit,
  });
  return {
    ok: true,
    text: formatHits(hits, `${hits.length} memories for "${truncate(args.query, 80)}":`),
    data: hits.map((hit) => ({
      id: hit.memory.id,
      type: hit.memory.memoryType,
      text: hit.memory.text,
      score: Number(hit.score.toFixed(4)),
      reasons: hit.reasons,
    })),
  };
}

async function buildContext(
  args: BuildContextArgs,
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
): Promise<MemoryToolResult> {
  const result = await ctx.backend.buildContext({
    query: args.query,
    filters: filtersFor(identity, false),
    budget: { maxItems: args.maxItems, maxChars: args.maxChars },
  });
  const text = result.contextText?.trim();
  return {
    ok: true,
    text: text && text.length > 0 ? text : "No stored memory for this actor yet.",
    data: {
      totalMemories: result.totalMemories,
      ids: result.selectedMemories.map((memory) => memory.id),
    },
  };
}

async function forget(
  args: ForgetArgs,
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
): Promise<MemoryToolResult> {
  const scope = { tenantId: identity.tenantId, appId: identity.appId };
  // Downrank first: feedback only applies to active records.
  const downranked = await ctx.backend.applyFeedback({ memoryId: args.memoryId, signal: "negative", ...scope });

  if (!ctx.backend.retire) {
    if (!downranked.updated) {
      return { ok: false, text: `No active memory with id=${args.memoryId}.` };
    }
    return {
      ok: true,
      text: `Downranked ${args.memoryId}. This memory-core service is remote and exposes no status endpoint, so the memory is suppressed in ranking but not archived.`,
      data: { memoryId: args.memoryId, archived: false },
    };
  }

  const retired = await ctx.backend.retire(
    args.memoryId,
    "archived",
    {
      forgottenAt: new Date().toISOString(),
      forgottenReason: args.reason ?? null,
      forgottenBy: identity.actorId,
    },
    scope,
  );

  if (!retired) {
    return { ok: false, text: `No active memory with id=${args.memoryId}. It may already be forgotten.` };
  }
  return {
    ok: true,
    text: `Forgot ${args.memoryId}. It will not be recalled again.`,
    data: { memoryId: args.memoryId, archived: true },
  };
}

async function supersede(
  args: SupersedeArgs,
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
): Promise<MemoryToolResult> {
  const idScope = { tenantId: identity.tenantId, appId: identity.appId };
  const previous = ctx.backend.getById ? await ctx.backend.getById(args.memoryId, idScope) : null;
  if (ctx.backend.getById && !previous) {
    return { ok: false, text: `No active memory with id=${args.memoryId}.` };
  }
  if (previous && previous.text.trim().toLowerCase() === args.newText.trim().toLowerCase()) {
    return { ok: false, text: `newText is identical to ${args.memoryId}; nothing to supersede.` };
  }

  const memoryType = previous?.memoryType ?? "fact";
  const scope = previous?.scope ?? "actor";
  const importance = previous?.importance ?? 0.5;

  const ingested = await ctx.backend.ingest([
    observationFor(
      ctx,
      identity,
      { text: args.newText, memoryType, scope, importance },
      { supersedes: args.memoryId, supersedeReason: args.reason ?? null },
    ),
  ]);
  const newId = ingested.ids[0];

  await ctx.backend.applyFeedback({ memoryId: args.memoryId, signal: "negative", ...idScope });

  if (!ctx.backend.retire) {
    return {
      ok: true,
      text: `Stored replacement${newId ? ` id=${newId}` : ""} and downranked ${args.memoryId}. Remote memory-core exposes no status endpoint, so the old memory is suppressed but not archived.`,
      data: { memoryId: args.memoryId, newId, archived: false },
    };
  }

  await ctx.backend.retire(
    args.memoryId,
    "superseded",
    {
      supersededAt: new Date().toISOString(),
      supersededBy: newId ?? null,
      supersedeReason: args.reason ?? null,
    },
    idScope,
  );

  return {
    ok: true,
    text: `Replaced ${args.memoryId} with [${memoryType}] ${truncate(args.newText, 120)}${newId ? ` — id=${newId}` : ""}`,
    data: { memoryId: args.memoryId, newId, archived: true },
  };
}

async function feedback(
  args: FeedbackArgs,
  ctx: MemoryToolContext,
  identity: MemoryIdentity,
): Promise<MemoryToolResult> {
  const signal = SIGNAL_MAP[args.signal];
  const result = await ctx.backend.applyFeedback({
    memoryId: args.memoryId,
    signal,
    tenantId: identity.tenantId,
    appId: identity.appId,
  });
  if (!result.updated) {
    return { ok: false, text: `No active memory with id=${args.memoryId}.` };
  }
  return {
    ok: true,
    text: `Recorded "${args.signal}" for ${args.memoryId}.`,
    data: { memoryId: args.memoryId, signal },
  };
}
