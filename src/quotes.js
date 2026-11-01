// Quote adapter for NEAR Intents (1Click).
//
// Two modes, always labelled:
//   live      — POST /v0/quote, dry run (no funds move, no deposit address needed)
//   snapshot  — derived from the bundled token snapshot when the API is slow/unreachable
//
// The engine refuses to sign on a missing price, so a silent fallback would be
// dangerous. Instead every quote carries `source` and the UI shows it.

import * as assets from "./assets.js";

const API = "https://1click.chaindefuser.com/v0/quote";
const ZERO_EVM = "0x0000000000000000000000000000000000000000";

export function referenceOut({ from, to, amount }) {
  const pFrom = assets.priceOf(from.symbol, from.chain);
  const pTo = assets.priceOf(to.symbol, to.chain);
  const usd = Number(amount) * pFrom;
  const gross = usd / pTo;
  return { out: gross, usd, pFrom, pTo };
}

export function snapshotQuote({ from, to, amount, feeBps = 30 }) {
  const { out, usd } = referenceOut({ from, to, amount });
  const net = out * (1 - feeBps / 10000);
  return {
    source: "snapshot",
    amountIn: Number(amount),
    amountOut: Number(net.toFixed(6)),
    notionalUsd: Number(usd.toFixed(2)),
    feeBps,
    route: `${from.symbol}@${from.chain || "auto"} → ${to.symbol}@${to.chain || "auto"}`,
    note: "priced from the bundled token snapshot; not a live executable quote",
  };
}

/**
 * Ask 1Click for a dry quote. Falls back to the snapshot on any failure.
 * A dry quote never moves money and needs no funded wallet.
 */
export async function liveQuote({ from, to, amount, slippageBps = 100, timeoutMs = 8000 }) {
  const a = assets.find(from.symbol, from.chain);
  const b = assets.find(to.symbol, to.chain);
  if (!a || !b) {
    return { ...snapshotQuote({ from, to, amount }), source: "snapshot", note: "asset missing from registry" };
  }
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset: a.assetId,
    destinationAsset: b.assetId,
    amount: assets.toBaseUnits(amount, from.symbol, from.chain).toString(),
    refundTo: ZERO_EVM,
    recipient: ZERO_EVM,
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const q = await res.json();
    const out = Number(q.quote?.amountOutFormatted ?? q.amountOut ?? 0);
    if (!(out > 0)) throw new Error("quote had no amountOut");
    return {
      source: "live",
      amountIn: Number(amount),
      amountOut: Number(out.toFixed(6)),
      notionalUsd: Number((Number(amount) * assets.priceOf(from.symbol, from.chain)).toFixed(2)),
      route: `${from.symbol} → ${to.symbol}`,
      timeEstimate: q.quote?.timeEstimate ?? null,
      depositAddress: q.quote?.depositAddress ?? null,
      raw: q.quote ?? q,
    };
  } catch (err) {
    const fb = snapshotQuote({ from, to, amount });
    return { ...fb, note: `live quote unavailable (${err.message}); priced from snapshot` };
  } finally {
    clearTimeout(timer);
  }
}
