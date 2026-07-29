/**
 * memory-core internal retrieval suite (MCIR) — dataset spec + generator.
 *
 * This is a SYNTHETIC dataset authored for this repository. It is not LongMemEval,
 * not LoCoMo, and not any published benchmark; see bench/README.md before quoting
 * any number produced from it.
 *
 * Determinism: every random choice comes from the seeded Rng in bench/rng.ts.
 * Timestamps are stored as relative dayOffset/minuteOfDay, never wall-clock, so
 * `generate --seed=S --size=Z` produces a byte-identical file every run.
 */
import { Rng, UniquePool, crossPool } from "../rng.js";
import type { BenchMemory, Dataset, EvalItem, Family, MemoryRole } from "../types.js";
import type { MemoryType } from "../../src/types.js";

export const DATASET_NAME = "memory-core-internal-retrieval";
export const DATASET_VERSION = "1.0.0";

/**
 * Tokens hardcoded into src/providers/enhanced-provider.ts entity gazetteers.
 * The corpus must contain none of them: a gazetteer keyed to another benchmark's
 * answer set would hand one system free points and make the comparison dishonest.
 */
export const GAZETTEER_TOKENS = [
  "rachel", "john", "mary", "mike", "sarah", "david",
  "yellowstone", "hawaii", "virginia", "california", "cathedral",
  "effective communication", "data analysis", "time management", "python",
  "tomatoes", "marigolds", "seeds",
  "bike", "car", "vehicle", "laptop", "phone", "smartphone", "tablet",
  "gps",
];

/** Attributes the generator never writes, so abstention queries are truly unanswerable. */
export const ABSTENTION_ATTRIBUTES = [
  "home address", "postcode", "approved budget", "auditor", "firmware version",
  "blood type", "shoe size", "passport number",
];

// ---------------------------------------------------------------------------
// Vocabulary pools
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Alina", "Bram", "Cedric", "Dilara", "Esben", "Fenna", "Gustav", "Hana", "Idris", "Juno",
  "Kalle", "Lubna", "Marek", "Nadia", "Osian", "Pilar", "Quim", "Rasmus", "Selin", "Tomas",
  "Ulrika", "Viggo", "Wren", "Xiomara", "Yusuf", "Zara", "Ansel", "Beatriz", "Casimir", "Delphine",
  "Emeka", "Freya", "Goran", "Halla", "Ivar", "Jelena", "Kwame", "Liesel", "Milo", "Noor",
  "Orla", "Petra", "Quentin", "Rhea", "Soren", "Talia", "Ugo", "Vesna", "Wanda", "Xander",
  "Yara", "Zoltan", "Amira", "Bodhi", "Clio", "Darius", "Elif", "Fabian", "Gita", "Hugo",
];

const LAST_NAMES = [
  "Adeyemi", "Bergqvist", "Corvino", "Duarte", "Ekstrom", "Falkner", "Gulbrand", "Hollis",
  "Ivanchuk", "Jarnvik", "Kowalczyk", "Lindqvist", "Moravec", "Nurmi", "Oyelaran", "Perrone",
  "Quaresma", "Rautio", "Steinholt", "Thanou", "Uddin", "Vasquez", "Wieland", "Xiong",
  "Yilmaz", "Zdravkov", "Almeida", "Brennan", "Castellan", "Drummond",
];

const PROJECT_CODES = [
  "Kestrel", "Lantern", "Marlow", "Nimbus", "Obsidian", "Pennant", "Quarry", "Ridgeline",
  "Sable", "Thistle", "Umber", "Verglas", "Waypoint", "Xebec", "Yarrow", "Zephyr",
  "Alcove", "Bramble", "Cinder", "Driftwood", "Ember", "Foxglove", "Gantry", "Halyard",
  "Inkwell", "Jetty", "Kiln", "Loam", "Millstone", "Nettle", "Orchard", "Palisade",
  "Quill", "Rookery", "Saltmarsh", "Tinder", "Undertow", "Vellum", "Windlass", "Yardarm",
  "Ashgrove", "Beacon", "Coppice", "Dovecote", "Elmshaw",
];

const PROJECT_SUFFIXES = [
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "11", "12", "13", "14", "15",
  "16", "17", "18", "19", "21", "22", "23", "24", "25", "26", "27", "28", "29", "31",
  "32", "33", "34", "35", "36", "37", "38", "39", "41", "42", "43", "44",
];

const ORG_PREFIXES = [
  "Halden", "Corvid", "Brannock", "Delmarva", "Eastcote", "Frostline", "Girvan", "Harlow",
  "Ingleby", "Joinery", "Kelvinside", "Larkhall", "Marchmont", "Northbrae", "Oakfield",
  "Pollok", "Quarrier", "Rutherglen", "Southwick", "Thornliebank", "Uphall", "Vartry",
  "Westerton", "Yoker", "Zetland", "Ardrossan", "Blythswood", "Cathcart", "Dennistoun",
  "Eaglesham", "Finnieston", "Gorbals", "Hillhead", "Ibrox", "Jordanhill", "Kinning",
  "Langside", "Merrylee", "Nitshill", "Overtoun", "Partick", "Riddrie", "Scotstoun",
  "Temple", "Uddingston",
];

const ORG_SUFFIXES = [
  "Freight", "Analytics", "Foundry", "Logistics", "Instruments", "Bindery", "Optics",
  "Textiles", "Cartage", "Joinery", "Metalwork", "Provisions", "Surveying", "Cabling",
  "Glassworks", "Millworks", "Haulage", "Chandlery", "Ropeworks", "Tannery", "Brickworks",
  "Ironworks", "Cooperage", "Sailmakers", "Weavers", "Printers", "Dyeworks", "Forgeworks",
  "Quarries", "Kilnworks", "Boatyard", "Slateworks", "Limeworks", "Saltworks", "Papermills",
  "Cordage", "Foundries", "Wharfage", "Stoneworks", "Timberyard",
];

const DEVICE_BRANDS = [
  "Novara", "Perigee", "Auralis", "Balder", "Cendre", "Dornier", "Elstree", "Fairisle",
  "Galliard", "Hesper", "Ilex", "Jarrah", "Kelso", "Lammas", "Mistral", "Nardoo",
  "Ossian", "Pelham", "Quintain", "Roseal", "Sarsen", "Tellin", "Ulmus", "Vireo",
  "Wivern", "Xanthe", "Yealm", "Zander", "Aldous", "Brecon", "Calder", "Dunmore",
  "Ettrick", "Fintry", "Gairloch", "Hoylake", "Islay", "Jura", "Kintyre", "Lorne",
  "Morar", "Nevis", "Orkney", "Pitlochry", "Quiraing",
];

const DEVICE_MODELS = [
  "X2 headset", "R4 handset", "M7 console", "T1 tracker", "K9 recorder", "B3 receiver",
  "L5 scanner", "S8 monitor", "D6 relay", "G2 beacon", "V4 encoder", "P9 sensor",
  "C7 gateway", "H3 repeater", "N5 terminal", "W1 controller", "Z6 amplifier",
  "F8 modulator", "Q4 transponder", "J2 dispatcher", "A9 aggregator", "E3 collector",
  "U7 injector", "Y5 splitter", "O1 combiner", "I8 filter", "X6 shunt", "R2 tap",
  "M4 bridge", "T9 mux", "K3 demux", "B7 buffer", "L1 latch", "S5 register",
  "D8 counter", "G4 divider", "V2 doubler", "P6 mixer", "C1 detector", "H9 limiter",
];

// Non-anchor slots. These may repeat across items without making any gold label ambiguous.
const CITIES = [
  "Trondheim", "Ljubljana", "Valletta", "Gdansk", "Ravenna", "Tampere", "Cluj", "Aarhus",
  "Nicosia", "Bilbao", "Ostrava", "Bergen", "Rijeka", "Kaunas", "Split", "Salerno",
  "Umea", "Plovdiv", "Kosice", "Linz", "Ghent", "Malmo", "Reims", "Girona", "Braga",
  "Odense", "Turku", "Debrecen", "Maribor", "Pescara",
];
const VAULTS = ["ledger", "keyring", "strongbox", "lockbox", "cabinet", "escrow", "coffer", "reliquary"];
const PARTS = ["hinge", "gasket", "bearing", "shim", "coupler", "grommet", "bushing", "diaphragm", "flywheel", "solenoid"];
// Tool and team names are anchor-grade (they appear as the subject of a gold fact whose
// object must be unique), so they are built as cross-products, not flat lists.
const TOOL_BASES = [
  "Slatepad", "Quillbook", "Marginal", "Foldnote", "Reedline", "Cairnstack", "Tessera",
  "Wickpad", "Brambleaf", "Coppernote", "Duneline", "Emberpad",
];
const TOOL_SUFFIXES = [
  "Pro", "Lite", "Studio", "Cloud", "Desk", "Field", "Works", "Core", "Plus", "Air",
  "Base", "Edge", "Flow", "Grid", "Hub", "Ink",
];
const TEAM_QUALIFIERS = [
  "north", "south", "east", "west", "upper", "lower", "inner", "outer", "night", "early",
  "coastal", "inland", "central", "border", "harbour", "moorland", "riverside", "uphill",
  "seaward", "landward",
];
const DOMAINS = ["invoicing", "onboarding", "payroll", "shipping", "warranty", "returns", "escalation", "compliance"];
const STYLES = ["plain prose", "bullet form", "a numbered checklist", "a single paragraph", "tabular form", "diagram-first"];
const SECTIONS = ["rollout", "migration", "teardown", "handover", "postmortem", "appendix", "changelog"];
const TOPICS = ["invoice", "shipment", "renewal", "audit", "refund", "handover", "outage"];
const VENUES = ["Hallamshire depot", "Ardwick yard", "Rothesay pier", "Culross barn", "Nairn boathouse", "Selkirk mill"];
const TIMES = ["07:45", "08:15", "09:30", "10:00", "11:15", "13:45", "14:30", "16:00"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const PLANS = ["metered", "flat-rate", "prepaid", "annual retainer", "per-seat", "volume tier"];
const PRICES = ["£19", "£34", "£48", "£62", "£85", "£110", "£140"];
const RISKS = ["supplier lock-in", "customs delay", "staffing gap", "cable shortage", "permit lapse", "damp ingress"];
const MONTHS = ["January", "March", "April", "June", "July", "September", "October", "November"];
const TEAMS = [
  "logistics", "fabrication", "quality", "dispatch", "surveying", "maintenance",
  "packing", "haulage", "calibration", "intake", "dryhouse", "loading",
];
const INTERVALS = ["four", "six", "nine", "twelve", "eighteen"];

// ---------------------------------------------------------------------------
// Generator internals
// ---------------------------------------------------------------------------

/**
 * Anchors identify an item in its query and must be globally unique.
 * Foils fill distractor slots and are drawn from a DISJOINT half of the same
 * cross-product, so a distractor can never collide with some other item's anchor.
 */
class Namespace {
  private readonly anchors: UniquePool<string>;
  private readonly foils: string[];

  constructor(all: readonly string[], rng: Rng, label: string) {
    const shuffled = rng.shuffle(all);
    const split = Math.floor(shuffled.length / 2);
    this.anchors = new UniquePool(shuffled.slice(0, split), rng, `${label}:anchor`);
    this.foils = shuffled.slice(split);
  }

  anchor(): string {
    return this.anchors.take();
  }

  foil(rng: Rng): string {
    return this.foils[rng.int(0, this.foils.length - 1)]!;
  }

  get remainingAnchors(): number {
    return this.anchors.remaining;
  }
}

interface Ctx {
  rng: Rng;
  persons: Namespace;
  projects: Namespace;
  orgs: Namespace;
  devices: Namespace;
  tools: Namespace;
  teams: Namespace;
  sessionCount: number;
  memories: BenchMemory[];
  items: EvalItem[];
  /** Per-session running clock so memories inside one session are ordered. */
  sessionCursor: Map<number, number>;
  memCounter: number;
  /** Anchors already written to the corpus, reused by abstention queries. */
  knownAnchors: { persons: string[]; projects: string[]; orgs: string[]; devices: string[] };
  /** Prevents two abstention items asking the identical question. */
  usedAbstentionAnchors: Set<string>;
}

/**
 * Extra memories that mention an item's anchor but answer nothing. A real store holds
 * many memories per entity, so without these a bare anchor-token match would put gold
 * at rank 1 for free and every scorer would look excellent.
 */
const ANCHOR_NOISE_PER_ITEM = 4;

const NOISE_TEMPLATES: Array<(anchor: string, rng: Rng) => string> = [
  (a, r) => `${a} came up again in the ${r.pick(DAYS)} review.`,
  (a, r) => `Someone asked about ${a} on the ${r.pick(TOPICS)} thread.`,
  (a) => `There is an open note on ${a} that nobody has picked up.`,
  (a) => `The ${a} record was tidied during the spring clear-out.`,
  (a, r) => `${a} is mentioned in the ${r.pick(MONTHS)} summary.`,
  (a) => `Nothing new to report on ${a} this week.`,
  (a, r) => `${a} was moved to the ${r.pick(TEAMS)} board without comment.`,
];

function addAnchorNoise(ctx: Ctx, itemId: string | null, anchor: string): string[] {
  const order = ctx.rng.shuffle(NOISE_TEMPLATES).slice(0, ANCHOR_NOISE_PER_ITEM);
  return order.map((make) =>
    addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount),
      memoryType: "episode",
      role: itemId ? "hard-negative" : "filler",
      itemId,
      text: make(anchor, ctx.rng),
      importance: 0.4,
    }).id,
  );
}

/** Session 1 is oldest. dayOffset counts days back from the run's time anchor. */
function sessionDayOffset(sessionIndex: number, sessionCount: number, rng: Rng): number {
  const gap = 3;
  return (sessionCount - sessionIndex) * gap + rng.int(0, 2);
}

function addMemory(
  ctx: Ctx,
  opts: {
    sessionIndex: number;
    text: string;
    memoryType: MemoryType;
    role: MemoryRole;
    itemId: string | null;
    confidence?: number;
    importance?: number;
  },
): BenchMemory {
  const id = `m${String(ctx.memCounter++).padStart(5, "0")}`;
  const cursor = (ctx.sessionCursor.get(opts.sessionIndex) ?? 0) + ctx.rng.int(3, 40);
  ctx.sessionCursor.set(opts.sessionIndex, cursor);
  const mem: BenchMemory = {
    id,
    sessionId: `s${String(opts.sessionIndex).padStart(3, "0")}`,
    sessionIndex: opts.sessionIndex,
    dayOffset: sessionDayOffset(opts.sessionIndex, ctx.sessionCount, ctx.rng),
    minuteOfDay: Math.min(cursor + 480, 1439),
    memoryType: opts.memoryType,
    text: opts.text,
    role: opts.role,
    itemId: opts.itemId,
    confidence: opts.confidence ?? 0.9,
    importance: opts.importance ?? 0.6,
  };
  ctx.memories.push(mem);
  return mem;
}

/** Two session indices with early < late, so "first"/"latest" labels are well defined. */
function twoSessions(ctx: Ctx): { early: number; late: number } {
  const early = ctx.rng.int(1, Math.max(1, ctx.sessionCount - 4));
  const late = ctx.rng.int(early + 2, ctx.sessionCount);
  return { early, late: Math.min(late, ctx.sessionCount) };
}

type TemplateResult = { memories: BenchMemory[]; item: EvalItem | null };
type Template = (ctx: Ctx, itemId: string) => TemplateResult;

// --- single-hop -------------------------------------------------------------

const singleHopTemplates: Template[] = [
  (ctx, itemId) => {
    const project = ctx.projects.anchor();
    const vault = ctx.rng.pick(VAULTS);
    const s = ctx.rng.int(1, ctx.sessionCount);
    ctx.knownAnchors.projects.push(project);
    const gold = addMemory(ctx, {
      sessionIndex: s, memoryType: "fact", role: "gold", itemId,
      text: `The deploy key for ${project} is stored in the ${vault} vault.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: s, memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${project} runbook is stored in the team wiki rather than in any vault.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `The deploy key for ${ctx.projects.foil(ctx.rng)} is stored in the ${ctx.rng.pick(VAULTS)} vault.`,
    });
    return {
      memories: [gold, hnA, hnB],
      item: {
        id: itemId, family: "single-hop", anchor: project,
        query: `Where is the deploy key for ${project} stored?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "One distractor repeats the anchor with 'stored' and 'vault' but no key; the other is the identical sentence about a different project.",
      },
    };
  },
  (ctx, itemId) => {
    // Anchored on the org, not the domain: DOMAINS repeats, so a domain-keyed query
    // would collide with another item at larger sizes and make both golds ambiguous.
    const org = ctx.orgs.anchor();
    const person = ctx.persons.anchor();
    const domain = ctx.rng.pick(DOMAINS);
    const s = ctx.rng.int(1, ctx.sessionCount);
    ctx.knownAnchors.orgs.push(org);
    ctx.knownAnchors.persons.push(person);
    const gold = addMemory(ctx, {
      sessionIndex: s, memoryType: "fact", role: "gold", itemId,
      text: `${person} handles the ${domain} escalations for ${org} on the night shift.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: s, memoryType: "fact", role: "hard-negative", itemId,
      text: `${person} came off the ${org} day shift rota back in ${ctx.rng.pick(MONTHS)}.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${ctx.persons.foil(ctx.rng)} used to handle the ${domain} escalations for ${org} on the night shift before the rota changed.`,
    });
    return {
      memories: [gold, hnA, hnB],
      item: {
        id: itemId, family: "single-hop", anchor: org,
        query: `Who handles the ${domain} escalations for ${org} on the night shift?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "Second distractor is a near-identical sentence with the same org and domain, a different person, and past tense.",
      },
    };
  },
  (ctx, itemId) => {
    const device = ctx.devices.anchor();
    const partA = ctx.rng.pick(PARTS);
    const partB = ctx.rng.pick(PARTS.filter((p) => p !== partA));
    const interval = ctx.rng.pick(INTERVALS);
    const s = ctx.rng.int(1, ctx.sessionCount);
    ctx.knownAnchors.devices.push(device);
    const gold = addMemory(ctx, {
      sessionIndex: s, memoryType: "fact", role: "gold", itemId,
      text: `The ${device} needs its ${partA} replaced every ${interval} months.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: s, memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${device} shipped with a sealed ${partB} that never needs replacing.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `Most units need the ${partA} replaced every ${ctx.rng.pick(INTERVALS)} months, though the ${ctx.devices.foil(ctx.rng)} is the exception.`,
    });
    return {
      memories: [gold, hnA, hnB],
      item: {
        id: itemId, family: "single-hop", anchor: device,
        query: `How often does the ${device} need its ${partA} replaced?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "Distractors reuse the anchor with the wrong part, and the right part with the wrong device.",
      },
    };
  },
];

// --- multi-session ----------------------------------------------------------

const multiSessionTemplates: Template[] = [
  (ctx, itemId) => {
    const org = ctx.orgs.anchor();
    const person = ctx.persons.anchor();
    const city = ctx.rng.pick(CITIES);
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.orgs.push(org);
    ctx.knownAnchors.persons.push(person);
    const g1 = addMemory(ctx, {
      sessionIndex: early, memoryType: "fact", role: "gold", itemId,
      text: `My contact at ${org} is ${person}.`,
    });
    const g2 = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "gold", itemId,
      text: `${org} relocated its entire support desk to ${city}.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${person} was based in ${ctx.rng.pick(CITIES)} before joining ${org}.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${ctx.orgs.foil(ctx.rng)} relocated its support desk to ${ctx.rng.pick(CITIES)} as well.`,
    });
    return {
      memories: [g1, g2, hnA, hnB],
      item: {
        id: itemId, family: "multi-session", anchor: person,
        query: `Which city is my contact ${person} at ${org} working out of now?`,
        goldMemoryIds: [g1.id, g2.id], requiresAll: true,
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "The top distractor contains the person, the org and a city — every query token — but the wrong city.",
      },
    };
  },
  (ctx, itemId) => {
    const project = ctx.projects.anchor();
    const person = ctx.persons.anchor();
    // Unique team: two items sharing a team name would put contradictory
    // "the X team reports to ..." facts in one corpus.
    const team = ctx.teams.anchor();
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.projects.push(project);
    ctx.knownAnchors.persons.push(person);
    const g1 = addMemory(ctx, {
      sessionIndex: early, memoryType: "project", role: "gold", itemId,
      text: `${project} is owned by the ${team} team.`,
    });
    const g2 = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "gold", itemId,
      text: `The ${team} team reports to ${person}.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${project} was reviewed by ${ctx.persons.foil(ctx.rng)} last cycle.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${ctx.teams.foil(ctx.rng)} team reports to ${ctx.persons.foil(ctx.rng)}.`,
    });
    return {
      memories: [g1, g2, hnA, hnB],
      item: {
        id: itemId, family: "multi-session", anchor: project,
        query: `Who does the team that owns ${project} report to?`,
        goldMemoryIds: [g1.id, g2.id], requiresAll: true,
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "Neither gold memory contains both the project and the answer; a one-hop retriever can only ever get half.",
      },
    };
  },
  (ctx, itemId) => {
    const person = ctx.persons.anchor();
    // Unique tool: a repeated tool name would give the corpus two different prices
    // for the same product.
    const tool = ctx.tools.anchor();
    const domain = ctx.rng.pick(DOMAINS);
    const price = ctx.rng.pick(PRICES);
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.persons.push(person);
    const g1 = addMemory(ctx, {
      sessionIndex: early, memoryType: "fact", role: "gold", itemId,
      text: `${person} moved all of the ${domain} notes over to ${tool}.`,
    });
    const g2 = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "gold", itemId,
      text: `${tool} charges ${price} a month on the team plan.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${ctx.tools.foil(ctx.rng)} charges ${ctx.rng.pick(PRICES)} a month, which is why ${person} did not pick it for the ${domain} notes.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${domain} notes were free when they lived in a plain text file.`,
    });
    return {
      memories: [g1, g2, hnA, hnB],
      item: {
        id: itemId, family: "multi-session", anchor: person,
        query: `What is ${person} paying each month for the ${domain} notes setup?`,
        goldMemoryIds: [g1.id, g2.id], requiresAll: true,
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "The top distractor names the person, the domain and a monthly price, and is a single-memory answer that is wrong.",
      },
    };
  },
];

// --- temporal ---------------------------------------------------------------

const temporalTemplates: Template[] = [
  (ctx, itemId) => {
    const device = ctx.devices.anchor();
    const partA = ctx.rng.pick(PARTS);
    const partB = ctx.rng.pick(PARTS.filter((p) => p !== partA));
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.devices.push(device);
    // gold is the OLDER memory and avoids the word "problem"; the newer trap uses it twice.
    const gold = addMemory(ctx, {
      sessionIndex: early, memoryType: "episode", role: "gold", itemId,
      text: `The first thing that went wrong with the ${device} was the ${partA} cutting out mid-run.`,
    });
    const trap = addMemory(ctx, {
      sessionIndex: late, memoryType: "episode", role: "hard-negative", itemId,
      text: `Now the ${device} has a second problem: the ${partB} rattles at speed, a worse problem than the last one.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "episode", role: "hard-negative", itemId,
      text: `The first problem with the ${ctx.devices.foil(ctx.rng)} was also a ${partA} fault.`,
    });
    return {
      memories: [gold, trap, hnB],
      item: {
        id: itemId, family: "temporal", anchor: device,
        query: `What was the first problem with the ${device}?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [trap.id, hnB.id],
        distractorNote: "The stale-but-wrong trap is BOTH more recent and a better lexical match ('problem' twice) than the gold memory.",
      },
    };
  },
  (ctx, itemId) => {
    const project = ctx.projects.anchor();
    const riskA = ctx.rng.pick(RISKS);
    const riskB = ctx.rng.pick(RISKS.filter((r) => r !== riskA));
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.projects.push(project);
    const trap = addMemory(ctx, {
      sessionIndex: early, memoryType: "fact", role: "hard-negative", itemId,
      text: `The risk flagged on ${project} was ${riskA}, and that ${riskA} risk is still the risk people bring up.`,
    });
    const gold = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "gold", itemId,
      text: `As of this week the biggest concern on ${project} is ${riskB}.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `The most recent risk flagged on ${ctx.projects.foil(ctx.rng)} is ${ctx.rng.pick(RISKS)}.`,
    });
    return {
      memories: [gold, trap, hnB],
      item: {
        id: itemId, family: "temporal", anchor: project,
        query: `What is the most recent risk flagged on ${project}?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [trap.id, hnB.id],
        distractorNote: "The superseded memory says 'risk' four times and the gold one says 'concern', so lexical scoring prefers the stale answer.",
      },
    };
  },
  (ctx, itemId) => {
    const person = ctx.persons.anchor();
    const toolA = ctx.tools.foil(ctx.rng);
    let toolB = ctx.tools.foil(ctx.rng);
    while (toolB === toolA) toolB = ctx.tools.foil(ctx.rng);
    const domain = ctx.rng.pick(DOMAINS);
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.persons.push(person);
    const gold = addMemory(ctx, {
      sessionIndex: early, memoryType: "fact", role: "gold", itemId,
      text: `${person} started running ${domain} through ${toolA} in the spring.`,
    });
    const trap = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "hard-negative", itemId,
      text: `${person} replaced the old ${domain} setup with ${toolB} in the autumn.`,
    });
    return {
      memories: [gold, trap],
      item: {
        id: itemId, family: "temporal", anchor: person,
        query: `What was ${person} using for ${domain} before ${toolB}?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [trap.id],
        distractorNote: "The trap matches every query token including the tool name, but the answer is only in the earlier session.",
      },
    };
  },
];

// --- knowledge-update -------------------------------------------------------

const knowledgeUpdateTemplates: Template[] = [
  (ctx, itemId) => {
    const person = ctx.persons.anchor();
    const cityOld = ctx.rng.pick(CITIES);
    const cityNew = ctx.rng.pick(CITIES.filter((c) => c !== cityOld));
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.persons.push(person);
    const old = addMemory(ctx, {
      sessionIndex: early, memoryType: "profile", role: "superseded", itemId,
      text: `${person} lives in ${cityOld}.`,
    });
    const gold = addMemory(ctx, {
      sessionIndex: late, memoryType: "profile", role: "gold", itemId,
      text: `${person} no longer lives in ${cityOld}; ${person} now lives in ${cityNew}.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${person} still gets post forwarded from ${cityOld}.`,
    });
    return {
      memories: [old, gold, hnA],
      item: {
        id: itemId, family: "knowledge-update", anchor: person,
        query: `Where does ${person} live these days?`,
        goldMemoryIds: [gold.id], supersededMemoryIds: [old.id],
        hardNegativeIds: [hnA.id],
        distractorNote: "The superseded memory is short and an exact phrase match; the current one is longer and still mentions the old city.",
      },
    };
  },
  (ctx, itemId) => {
    const project = ctx.projects.anchor();
    const timeOld = ctx.rng.pick(TIMES);
    const timeNew = ctx.rng.pick(TIMES.filter((t) => t !== timeOld));
    const dayOld = ctx.rng.pick(DAYS);
    const dayNew = ctx.rng.pick(DAYS.filter((d) => d !== dayOld));
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.projects.push(project);
    const old = addMemory(ctx, {
      sessionIndex: early, memoryType: "fact", role: "superseded", itemId,
      text: `The ${project} standup is at ${timeOld} every ${dayOld}.`,
    });
    const gold = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "gold", itemId,
      text: `We moved the ${project} sync: it runs at ${timeNew} on ${dayNew} from now on.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${ctx.projects.foil(ctx.rng)} standup is at ${timeOld} every ${dayOld}.`,
    });
    return {
      memories: [old, gold, hnA],
      item: {
        id: itemId, family: "knowledge-update", anchor: project,
        query: `When is the ${project} standup?`,
        goldMemoryIds: [gold.id], supersededMemoryIds: [old.id],
        hardNegativeIds: [hnA.id],
        distractorNote: "The query uses the old wording ('standup'); the current memory says 'sync', so the superseded record wins on tokens.",
      },
    };
  },
  (ctx, itemId) => {
    const org = ctx.orgs.anchor();
    const planOld = ctx.rng.pick(PLANS);
    const planNew = ctx.rng.pick(PLANS.filter((p) => p !== planOld));
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.orgs.push(org);
    const old = addMemory(ctx, {
      sessionIndex: early, memoryType: "fact", role: "superseded", itemId,
      text: `${org} bills us on the ${planOld} plan.`,
    });
    const gold = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "gold", itemId,
      text: `${org} shifted our account off ${planOld} and onto the ${planNew} plan.`,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${ctx.orgs.foil(ctx.rng)} bills us on the ${planOld} plan too.`,
    });
    return {
      memories: [old, gold, hnA],
      item: {
        id: itemId, family: "knowledge-update", anchor: org,
        query: `Which plan does ${org} bill us on?`,
        goldMemoryIds: [gold.id], supersededMemoryIds: [old.id],
        hardNegativeIds: [hnA.id],
        distractorNote: "Superseded memory is a verbatim match for the query ('bills us on the ... plan').",
      },
    };
  },
];

// --- preference -------------------------------------------------------------

const preferenceTemplates: Template[] = [
  (ctx, itemId) => {
    const project = ctx.projects.anchor();
    const styleA = ctx.rng.pick(STYLES);
    const styleB = ctx.rng.pick(STYLES.filter((s) => s !== styleA));
    const section = ctx.rng.pick(SECTIONS);
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.projects.push(project);
    const gold = addMemory(ctx, {
      sessionIndex: early, memoryType: "preference", role: "gold", itemId,
      text: `For anything on ${project} I want write-ups in ${styleA}, never ${styleB}.`,
      importance: 0.85,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${project} ${section} section is due on ${ctx.rng.pick(DAYS)}.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "preference", role: "hard-negative", itemId,
      text: `${ctx.projects.foil(ctx.rng)} write-ups should be in ${styleB}.`,
    });
    return {
      memories: [gold, hnA, hnB],
      item: {
        id: itemId, family: "preference", anchor: project,
        query: `How should the ${project} ${section} section be written up?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "The distractor shares project AND section with the query; gold shares only the project name.",
      },
    };
  },
  (ctx, itemId) => {
    const org = ctx.orgs.anchor();
    const topic = ctx.rng.pick(TOPICS);
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.orgs.push(org);
    const gold = addMemory(ctx, {
      sessionIndex: early, memoryType: "preference", role: "gold", itemId,
      text: `With ${org} I only ever want async updates in writing, no calls.`,
      importance: 0.85,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: late, memoryType: "fact", role: "hard-negative", itemId,
      text: `The ${org} ${topic} delay was flagged by their duty manager.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `${ctx.orgs.foil(ctx.rng)} prefers a weekly call about any ${topic} delay.`,
    });
    return {
      memories: [gold, hnA, hnB],
      item: {
        id: itemId, family: "preference", anchor: org,
        query: `How should I follow up with ${org} about the ${topic} delay?`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "Gold shares one token with the query; both distractors share two or three.",
      },
    };
  },
  (ctx, itemId) => {
    const device = ctx.devices.anchor();
    const venue = ctx.rng.pick(VENUES);
    const { early, late } = twoSessions(ctx);
    ctx.knownAnchors.devices.push(device);
    const gold = addMemory(ctx, {
      sessionIndex: early, memoryType: "preference", role: "gold", itemId,
      text: `Keep the ${device} on the quiet profile — I cannot stand the alert chime.`,
      importance: 0.85,
    });
    const hnA = addMemory(ctx, {
      sessionIndex: late, memoryType: "episode", role: "hard-negative", itemId,
      text: `The ${device} came along on the last ${venue} trip and behaved fine.`,
    });
    const hnB = addMemory(ctx, {
      sessionIndex: ctx.rng.int(1, ctx.sessionCount), memoryType: "fact", role: "hard-negative", itemId,
      text: `Everything heading to the ${venue} trip needs a packing slip.`,
    });
    return {
      memories: [gold, hnA, hnB],
      item: {
        id: itemId, family: "preference", anchor: device,
        query: `Set the ${device} up for the ${venue} trip.`,
        goldMemoryIds: [gold.id],
        hardNegativeIds: [hnA.id, hnB.id],
        distractorNote: "The distractor matches device + venue + trip; the preference shares only the device name.",
      },
    };
  },
];

// --- abstention -------------------------------------------------------------

/** Abstention queries reuse an anchor that IS in the corpus, asking for an attribute that never appears. */
function makeAbstentionItem(ctx: Ctx, itemId: string): EvalItem | null {
  const shapes: Array<{ pool: keyof Ctx["knownAnchors"]; make: (a: string) => string; note: string }> = [
    { pool: "persons", make: (a) => `What is ${a}'s home address?`, note: "The person appears in several memories; their address appears in none." },
    { pool: "projects", make: (a) => `What approved budget does ${a} have?`, note: "The project is well covered in memory but no budget was ever stated." },
    { pool: "orgs", make: (a) => `Which auditor signed off on ${a}'s last review?`, note: "The org is present in memory; no auditor is." },
    { pool: "devices", make: (a) => `What firmware version is the ${a} running?`, note: "The device is present in memory; no firmware version is." },
  ];
  const order = ctx.rng.shuffle(shapes);
  for (const shape of order) {
    const pool = ctx.knownAnchors[shape.pool].filter((a) => !ctx.usedAbstentionAnchors.has(a));
    if (pool.length === 0) continue;
    const anchor = pool[ctx.rng.int(0, pool.length - 1)]!;
    ctx.usedAbstentionAnchors.add(anchor);
    return {
      id: itemId, family: "abstention",
      query: shape.make(anchor),
      goldMemoryIds: [],
      anchor,
      distractorNote: shape.note,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  seed?: number;
  size?: "small" | "large";
}

const FAMILY_MIX: Record<Family, number> = {
  "single-hop": 12,
  "multi-session": 8,
  temporal: 10,
  "knowledge-update": 8,
  abstention: 6,
  preference: 6,
};

const TEMPLATES: Record<Exclude<Family, "abstention">, Template[]> = {
  "single-hop": singleHopTemplates,
  "multi-session": multiSessionTemplates,
  temporal: temporalTemplates,
  "knowledge-update": knowledgeUpdateTemplates,
  preference: preferenceTemplates,
};

/** Filler memories come from real templates with fresh anchors; their eval items are dropped. */
const FILLER_TEMPLATES: Template[] = [
  ...singleHopTemplates, ...multiSessionTemplates, ...temporalTemplates,
  ...knowledgeUpdateTemplates, ...preferenceTemplates,
];

export function generateDataset(options: GenerateOptions = {}): Dataset {
  const seed = options.seed ?? 1337;
  const size = options.size ?? "small";
  const scale = size === "large" ? 10 : 1;
  const rng = new Rng(seed);

  const itemsPerFamily = Object.fromEntries(
    Object.entries(FAMILY_MIX).map(([f, n]) => [f, n * scale]),
  ) as Record<Family, number>;
  const totalItems = Object.values(itemsPerFamily).reduce((a, b) => a + b, 0);
  const fillerShadowItems = Math.max(10, Math.round(totalItems * 0.6));
  const sessionCount = Math.min(240, Math.max(14, Math.round(totalItems / 3)));

  const ctx: Ctx = {
    rng,
    persons: new Namespace(crossPool(FIRST_NAMES, LAST_NAMES), rng, "persons"),
    projects: new Namespace(crossPool(PROJECT_CODES, PROJECT_SUFFIXES, "-"), rng, "projects"),
    orgs: new Namespace(crossPool(ORG_PREFIXES, ORG_SUFFIXES), rng, "orgs"),
    devices: new Namespace(crossPool(DEVICE_BRANDS, DEVICE_MODELS), rng, "devices"),
    tools: new Namespace(crossPool(TOOL_BASES, TOOL_SUFFIXES), rng, "tools"),
    teams: new Namespace(crossPool(TEAM_QUALIFIERS, TEAMS), rng, "teams"),
    sessionCount,
    memories: [],
    items: [],
    sessionCursor: new Map(),
    memCounter: 0,
    knownAnchors: { persons: [], projects: [], orgs: [], devices: [] },
    usedAbstentionAnchors: new Set(),
  };

  let itemCounter = 0;
  const nextItemId = (family: Family) => `${family}-${String(++itemCounter).padStart(4, "0")}`;

  // Filler first, so abstention anchors can draw from a populated corpus.
  for (let i = 0; i < fillerShadowItems; i++) {
    const template = FILLER_TEMPLATES[i % FILLER_TEMPLATES.length]!;
    const shadowId = `filler-${String(i).padStart(4, "0")}`;
    const before = ctx.memories.length;
    const { item } = template(ctx, shadowId);
    if (item?.anchor) addAnchorNoise(ctx, null, item.anchor);
    for (let j = before; j < ctx.memories.length; j++) {
      ctx.memories[j]!.role = "filler";
      ctx.memories[j]!.itemId = null;
    }
  }

  for (const family of Object.keys(itemsPerFamily) as Family[]) {
    if (family === "abstention") continue;
    const templates = TEMPLATES[family as Exclude<Family, "abstention">];
    for (let i = 0; i < itemsPerFamily[family]; i++) {
      const template = templates[i % templates.length]!;
      const { item } = template(ctx, nextItemId(family));
      if (!item) continue;
      if (item.anchor) {
        const noiseIds = addAnchorNoise(ctx, item.id, item.anchor);
        item.hardNegativeIds = [...(item.hardNegativeIds ?? []), ...noiseIds];
      }
      ctx.items.push(item);
    }
  }

  for (let i = 0; i < itemsPerFamily.abstention; i++) {
    const item = makeAbstentionItem(ctx, nextItemId("abstention"));
    if (item) ctx.items.push(item);
  }

  // Stable ordering so the fixture file diffs cleanly.
  ctx.memories.sort((a, b) => a.id.localeCompare(b.id));
  ctx.items.sort((a, b) => a.id.localeCompare(b.id));

  const byFamily: Record<string, number> = {};
  for (const item of ctx.items) byFamily[item.family] = (byFamily[item.family] ?? 0) + 1;
  const byRole: Record<string, number> = {};
  for (const m of ctx.memories) byRole[m.role] = (byRole[m.role] ?? 0) + 1;

  const dataset: Dataset = {
    meta: {
      name: DATASET_NAME,
      version: DATASET_VERSION,
      seed,
      size,
      generatedBy: "bench/dataset/generate.ts",
      counts: {
        items: ctx.items.length,
        memories: ctx.memories.length,
        sessions: sessionCount,
        byFamily,
        byRole,
      },
    },
    memories: ctx.memories,
    items: ctx.items,
  };

  validateDataset(dataset);
  return dataset;
}

/** Fails loudly on the label-integrity properties the metrics silently assume. */
export function validateDataset(dataset: Dataset): void {
  const problems: string[] = [];
  const byId = new Map(dataset.memories.map((m) => [m.id, m]));

  for (const item of dataset.items) {
    for (const id of item.goldMemoryIds) {
      if (!byId.has(id)) problems.push(`${item.id}: gold id ${id} not in corpus`);
    }
    for (const id of item.supersededMemoryIds ?? []) {
      if (!byId.has(id)) problems.push(`${item.id}: superseded id ${id} not in corpus`);
    }
    if (item.family === "abstention" && item.goldMemoryIds.length > 0) {
      problems.push(`${item.id}: abstention item must have no gold`);
    }
    if (item.family !== "abstention" && item.goldMemoryIds.length === 0) {
      problems.push(`${item.id}: answerable item has no gold`);
    }
  }

  // Two items sharing a query, or an answerable item whose query is not keyed on a
  // globally unique anchor, means two different gold labels answer the same question.
  // That inflates every scorer's miss rate for reasons that have nothing to do with retrieval.
  const seenQueries = new Map<string, string>();
  const seenAnchors = new Map<string, string>();
  for (const item of dataset.items) {
    const prevQuery = seenQueries.get(item.query);
    if (prevQuery) problems.push(`${item.id}: duplicate query, also asked by ${prevQuery}`);
    seenQueries.set(item.query, item.id);

    if (item.family === "abstention") continue;
    if (!item.anchor) {
      problems.push(`${item.id}: answerable item has no anchor label`);
      continue;
    }
    if (!item.query.includes(item.anchor)) {
      problems.push(`${item.id}: anchor "${item.anchor}" does not appear in its own query`);
    }
    const prevAnchor = seenAnchors.get(item.anchor);
    if (prevAnchor) problems.push(`${item.id}: anchor "${item.anchor}" reused by ${prevAnchor}`);
    seenAnchors.set(item.anchor, item.id);
  }

  const corpusBlob = dataset.memories.map((m) => m.text).join(" \n").toLowerCase();
  // Single-word gazetteer entries are checked as whole tokens ("car" must not match "Cartage").
  const corpusTokens = new Set(corpusBlob.split(/[^a-z0-9]+/).filter(Boolean));
  for (const token of GAZETTEER_TOKENS) {
    const hit = token.includes(" ") ? corpusBlob.includes(token) : corpusTokens.has(token);
    if (hit) problems.push(`corpus contains hardcoded gazetteer token "${token}"`);
  }
  for (const attr of ABSTENTION_ATTRIBUTES) {
    if (corpusBlob.includes(attr)) {
      problems.push(`corpus states "${attr}", which abstention items assume is absent`);
    }
  }

  // Every abstention anchor must actually appear in the corpus, or the item is trivial.
  for (const item of dataset.items) {
    if (item.family !== "abstention") continue;
    if (!item.anchor) {
      problems.push(`${item.id}: abstention item is missing its anchor label`);
    } else if (!corpusBlob.includes(item.anchor.toLowerCase())) {
      problems.push(`${item.id}: abstention anchor "${item.anchor}" is absent from the corpus (item is trivially unanswerable)`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Dataset validation failed:\n  - ${problems.slice(0, 20).join("\n  - ")}`);
  }
}
