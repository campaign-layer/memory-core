#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.resolve(
  process.env.MEMORY_CORE_ORCHESTRATION_STATE || path.join(root, ".orchestration", "status.json"),
);
const statusOrder = ["blocked", "failed", "review", "running", "queued", "complete"];
const glyph = {
  blocked: "!",
  failed: "x",
  review: "?",
  running: ">",
  queued: ".",
  complete: "✓",
};

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      const now = new Date().toISOString();
      const state = {
        runId: `local-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`,
        objective: "Track parallel Memory Core work",
        startedAt: now,
        updatedAt: now,
        lanes: [],
        gates: [],
      };
      writeState(state);
      return state;
    }
    throw new Error(`cannot read ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeState(state) {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, statePath);
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function age(iso) {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function clip(value, width) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(1, width - 1))}…`;
}

function render() {
  const state = readState();
  const head = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain") === "" ? "clean" : "dirty";
  const lanes = [...state.lanes].sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  const counts = Object.fromEntries(statusOrder.map((status) => [status, lanes.filter((lane) => lane.status === status).length]));
  const out = [];
  out.push(`MEMORY CORE ORCHESTRATION  ${state.runId}`);
  out.push(`${state.objective}`);
  out.push(`updated ${state.updatedAt}  elapsed ${age(state.startedAt)}  git ${head} ${dirty}`);
  out.push(`running ${counts.running}  review ${counts.review}  queued ${counts.queued}  blocked ${counts.blocked}  failed ${counts.failed}  complete ${counts.complete}`);
  out.push("");
  out.push(`${clip("STATE", 9)} ${clip("LANE", 22)} ${clip("OWNER", 18)} ${clip("AGE", 7)} LATEST`);
  out.push("─".repeat(100));
  for (const lane of lanes) {
    out.push(`${clip(`${glyph[lane.status] ?? "?"} ${lane.status}`, 9)} ${clip(lane.name, 22)} ${clip(lane.owner, 18)} ${clip(age(lane.startedAt), 7)} ${lane.latest}`);
  }
  if (lanes.length === 0) out.push("No lanes yet. Add one with the `add` command shown by --help.");
  if (state.gates?.length) {
    out.push("");
    out.push("GATES");
    for (const gate of state.gates) out.push(` ${glyph[gate.status] ?? "?"} ${clip(gate.name, 32)} ${gate.latest}`);
  }
  out.push("");
  out.push(`state: ${statePath}`);
  process.stdout.write(`${out.join("\n")}\n`);
}

function setLane([id, status, ...message]) {
  if (!id || !status || message.length === 0) {
    throw new Error("usage: orchestration-dashboard.mjs set <lane-id> <status> <message>");
  }
  if (!statusOrder.includes(status)) throw new Error(`status must be one of: ${statusOrder.join(", ")}`);
  const state = readState();
  const lane = state.lanes.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`unknown lane ${id}`);
  lane.status = status;
  lane.latest = message.join(" ");
  lane.updatedAt = new Date().toISOString();
  state.updatedAt = lane.updatedAt;
  writeState(state);
  render();
}

function addLane([id, status, owner, name, ...message]) {
  if (!id || !status || !owner || !name || message.length === 0) {
    throw new Error("usage: orchestration-dashboard.mjs add <lane-id> <status> <owner> <name> <message>");
  }
  if (!statusOrder.includes(status)) throw new Error(`status must be one of: ${statusOrder.join(", ")}`);
  const state = readState();
  if (state.lanes.some((candidate) => candidate.id === id)) throw new Error(`lane ${id} already exists`);
  const now = new Date().toISOString();
  state.lanes.push({ id, name, owner, status, startedAt: now, updatedAt: now, latest: message.join(" ") });
  state.updatedAt = now;
  writeState(state);
  render();
}

function setGate([name, status, ...message]) {
  if (!name || !status || message.length === 0) {
    throw new Error("usage: orchestration-dashboard.mjs gate <gate-name> <status> <message>");
  }
  if (!statusOrder.includes(status)) throw new Error(`status must be one of: ${statusOrder.join(", ")}`);
  const state = readState();
  const gate = state.gates?.find((candidate) => candidate.name === name);
  if (!gate) throw new Error(`unknown gate ${name}`);
  gate.status = status;
  gate.latest = message.join(" ");
  gate.updatedAt = new Date().toISOString();
  state.updatedAt = gate.updatedAt;
  writeState(state);
  render();
}

function addGate([status, name, ...message]) {
  if (!status || !name || message.length === 0) {
    throw new Error("usage: orchestration-dashboard.mjs add-gate <status> <name> <message>");
  }
  if (!statusOrder.includes(status)) throw new Error(`status must be one of: ${statusOrder.join(", ")}`);
  const state = readState();
  if (state.gates?.some((candidate) => candidate.name === name)) throw new Error(`gate ${name} already exists`);
  const now = new Date().toISOString();
  (state.gates ??= []).push({ name, status, updatedAt: now, latest: message.join(" ") });
  state.updatedAt = now;
  writeState(state);
  render();
}

const [command = "--once", ...rest] = process.argv.slice(2);
if (command === "set") {
  setLane(rest);
} else if (command === "add") {
  addLane(rest);
} else if (command === "gate") {
  setGate(rest);
} else if (command === "add-gate") {
  addGate(rest);
} else if (command === "--help" || command === "-h") {
  process.stdout.write([
    "usage:",
    "  orchestration-dashboard.mjs --once",
    "  orchestration-dashboard.mjs --watch[=seconds]",
    "  orchestration-dashboard.mjs add <lane-id> <status> <owner> <name> <message>",
    "  orchestration-dashboard.mjs set <lane-id> <status> <message>",
    "  orchestration-dashboard.mjs add-gate <status> <name> <message>",
    "  orchestration-dashboard.mjs gate <gate-name> <status> <message>",
    "",
  ].join("\n"));
} else if (command === "--once") {
  render();
} else if (command.startsWith("--watch")) {
  const seconds = Math.max(1, Number(command.split("=")[1] || 2));
  const draw = () => {
    if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
    render();
  };
  draw();
  const timer = setInterval(draw, seconds * 1000);
  process.once("SIGINT", () => { clearInterval(timer); process.exit(0); });
  process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
} else {
  throw new Error("unknown command; run orchestration-dashboard.mjs --help");
}
