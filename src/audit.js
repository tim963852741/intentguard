// Append-only audit log with a hash chain.
// Each record commits to the previous one, so deleting or editing history is
// detectable — which is the difference between "we log things" and "we can prove
// what the agent did at 03:00".

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "..", "data");
const FILE = join(DIR, "audit.jsonl");
const GENESIS = "0".repeat(64);

export function ensure() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function readAll() {
  ensure();
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function lastHash() {
  const rows = readAll();
  return rows.length ? rows[rows.length - 1].hash : GENESIS;
}

export function record(entry) {
  ensure();
  const prev = lastHash();
  const body = { seq: readAll().length + 1, at: new Date().toISOString(), ...entry, prev };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const row = { ...body, hash };
  appendFileSync(FILE, JSON.stringify(row) + "\n");
  return row;
}

/** Recompute the chain; returns the index of the first broken link, or null. */
export function verify() {
  const rows = readAll();
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const { hash, ...body } = rows[i];
    if (body.prev !== prev) return { ok: false, brokenAt: i, reason: "prev mismatch" };
    const h = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (h !== hash) return { ok: false, brokenAt: i, reason: "hash mismatch" };
    prev = hash;
  }
  return { ok: true, length: rows.length };
}

/** Truncate the log. Used by the demo so scenarios are reproducible. */
export function reset() {
  ensure();
  writeFileSync(FILE, "");
  return true;
}

export { FILE };
