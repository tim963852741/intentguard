// Natural-language intent parser. Deliberately small and rule-based: a payment
// parser that hallucinates is worse than one that refuses. Anything it cannot
// read becomes an explicit error, not a guess.

import * as assets from "./assets.js";

const CHAINS = ["near", "eth", "sol", "bsc", "pol", "base", "arbitrum", "ton", "btc"];

const DIRECTIONS = [
  /(\d+(?:\.\d+)?)\s*([A-Za-z0-9]{2,10})[\s\S]{0,12}?(?:to|into|换成|换到|换为|兑换成|转成|→|->)\s*([A-Za-z0-9]{2,10})/i,
  /(?:swap|convert|exchange|sell|buy|换|兑换|把)\s*(\d+(?:\.\d+)?)?\s*([A-Za-z0-9]{2,10})?[\s\S]*?([A-Za-z0-9]{2,10})/i,
];

function known(sym) {
  return assets.symbols().some((s) => s.toUpperCase() === String(sym).toUpperCase());
}

export function parseSlippage(text) {
  const m = text.match(/(?:滑点|slippage)[^\d]{0,6}([\d.]+)\s*%?/i);
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) ? Math.round(pct * 100) : null;
}

export function parseRecipient(text) {
  const evm = text.match(/0x[a-fA-F0-9]{40}/);
  if (evm) return evm[0];
  const near = text.match(/\b[a-z0-9_-]{2,64}\.(?:near|tg)\b/i);
  if (near) return near[0];
  const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  if (sol) return sol[0];
  return null;
}

export function parseChain(text, nearSymbol) {
  const names = CHAINS.join("|");
  const m =
    text.match(new RegExp(`(?:\\bon\\s+|在)\\s*(${names})\\b`, "i")) ||
    text.match(new RegExp(`\\b(${names})\\b\\s*(?:chain|链)`, "i"));
  if (m) return m[1].toLowerCase();
  const hit = assets.find(nearSymbol);
  return hit?.blockchain ?? null;
}

/**
 * @returns {{ok:boolean, intent?:object, error?:string, warnings:string[]}}
 */
export function parseIntent(text) {
  const warnings = [];
  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return { ok: false, error: "empty intent", warnings };
  }
  const clean = text.trim();

  // Walk every symbol mentioned, in order of appearance. The source leg is the
  // one a number sits in front of; the destination is the next symbol after it.
  // Mask addresses first: "alice.near" must not be read as the NEAR token.
  // The mask keeps the string length, so indices still line up with `clean`.
  const mask = (re) => {
    scan = scan.replace(re, (hit) => "x".repeat(hit.length));
  };
  let scan = clean;
  mask(/0x[a-fA-F0-9]{40}/g);
  mask(/\b[a-z0-9_-]{2,64}\.(?:near|tg)\b/gi);
  mask(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g);

  const mentions = [];
  const symRe = /[A-Za-z][A-Za-z0-9]{1,9}/g;
  let m;
  while ((m = symRe.exec(scan)) !== null) {
    if (known(m[0])) mentions.push({ symbol: m[0].toUpperCase(), index: m.index, raw: m[0] });
  }
  if (mentions.length === 0) {
    return { ok: false, error: "no known asset found — try a symbol like ETH, USDC, NEAR", warnings };
  }

  const amountBefore = (index) => {
    const head = scan.slice(0, index);
    // tolerate counters between the number and the symbol: "5 个 ETH", "5 of ETH"
    const hit = head.match(/(\d+(?:\.\d+)?)\s*(?:个|枚|笔|units?|of)?\s*$/i);
    return hit ? Number(hit[1]) : null;
  };

  let fromIdx = -1;
  let amount = null;
  for (let i = 0; i < mentions.length; i++) {
    const a = amountBefore(mentions[i].index);
    if (a !== null) { fromIdx = i; amount = a; break; }
  }
  if (fromIdx === -1) {
    return { ok: false, error: "no amount found before an asset (e.g. \"0.5 ETH\")", warnings };
  }
  const destIdx = mentions.findIndex((x, i) => i > fromIdx && x.symbol !== mentions[fromIdx].symbol);
  if (destIdx === -1) {
    return { ok: false, error: "only one leg found — a swap needs both a source and a destination asset", warnings };
  }
  const fromPair = { amount, symbol: mentions[fromIdx].symbol };
  const toPair = { symbol: mentions[destIdx].symbol };

  const recipient = parseRecipient(clean);
  const slippageBps = parseSlippage(clean);
  const fromChain = parseChain(clean, fromPair.symbol);
  const toChain = parseChain(clean, toPair.symbol);

  return {
    ok: true,
    warnings,
    intent: {
      text: clean,
      action: "swap",
      from: { symbol: fromPair.symbol, amount: fromPair.amount, chain: fromChain },
      to: { symbol: toPair.symbol, chain: toChain },
      recipient,
      slippageBps: slippageBps ?? 100,
    },
  };
}
