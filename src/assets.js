// Asset registry built from the NEAR Intents (1Click) token list.
// Ships with a snapshot so the demo runs offline; `refresh()` pulls live data.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(__dirname, "..", "fixtures", "tokens.snapshot.json");
const API = "https://1click.chaindefuser.com/v0/tokens";

let registry = [];
let source = "snapshot";
let updatedAt = null;

export function load() {
  const raw = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  registry = raw.filter((t) => t.assetId && t.symbol);
  source = "snapshot";
  updatedAt = raw[0]?.priceUpdatedAt ?? null;
  return registry;
}

export function all() {
  if (registry.length === 0) load();
  return registry;
}

export function symbols() {
  return [...new Set(all().map((t) => t.symbol))];
}

export function find(symbol, chain) {
  const s = String(symbol || "").toUpperCase();
  const list = all().filter((t) => t.symbol.toUpperCase() === s);
  if (chain) {
    const hit = list.find((t) => t.blockchain === chain);
    if (hit) return hit;
  }
  return list[0] ?? null;
}

export function priceOf(symbol, chain) {
  const t = find(symbol, chain);
  if (!t) throw new Error(`unknown asset: ${symbol}${chain ? ` on ${chain}` : ""}`);
  return Number(t.price);
}

export function meta() {
  return { source, count: all().length, updatedAt };
}

/** Convert a decimal amount to base units using the asset's decimals. */
export function toBaseUnits(amount, symbol, chain) {
  const t = find(symbol, chain);
  if (!t) throw new Error(`unknown asset: ${symbol}`);
  const [i, f = ""] = String(amount).split(".");
  const frac = (f + "0".repeat(t.decimals)).slice(0, t.decimals);
  return BigInt(i || "0") * 10n ** BigInt(t.decimals) + BigInt(frac || "0");
}

export function fromBaseUnits(base, symbol, chain) {
  const t = find(symbol, chain);
  if (!t) throw new Error(`unknown asset: ${symbol}`);
  const s = base.toString().padStart(t.decimals + 1, "0");
  const i = s.slice(0, s.length - t.decimals);
  const f = s.slice(s.length - t.decimals).replace(/0+$/, "");
  return Number(f ? `${i}.${f}` : i);
}

/**
 * Try to refresh from the live 1Click token list.
 * Never throws: on failure the snapshot stays in place and `source` remains "snapshot".
 */
export async function refresh({ timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const usable = data.filter((t) => t.assetId && t.symbol && t.price);
    if (usable.length === 0) throw new Error("empty token list");
    registry = usable;
    source = "live";
    updatedAt = new Date().toISOString();
    return { ok: true, count: usable.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err), kept: registry.length };
  } finally {
    clearTimeout(timer);
  }
}
