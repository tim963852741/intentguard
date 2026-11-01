// End-to-end: text → parsed intent → quote → policy decision → audit record.
// This is the only place the pieces meet, so the ordering is easy to follow:
// price it, gate it, log it. Never sign first and log later.

import * as assets from "./assets.js";
import * as audit from "./audit.js";
import { evaluate, short } from "./policy.js";
import { liveQuote, snapshotQuote, referenceOut } from "./quotes.js";
import { parseIntent } from "./agent.js";

export function rollingContext(rows, now = Date.now()) {
  const dayAgo = now - 24 * 3600 * 1000;
  const hourAgo = now - 3600 * 1000;
  let spentTodayUsd = 0;
  let txCountLastHour = 0;
  for (const r of rows) {
    if (r.decision !== "ALLOW") continue;
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) continue;
    if (t >= dayAgo) spentTodayUsd += r.notionalUsd || 0;
    if (t >= hourAgo) txCountLastHour += 1;
  }
  return { spentTodayUsd, txCountLastHour };
}

export async function run(text, { policy = {}, live = false } = {}) {
  const parsed = parseIntent(text);
  if (!parsed.ok) {
    const row = audit.record({
      kind: "parse_error",
      input: text,
      decision: "DENY",
      reasons: [parsed.error],
      notionalUsd: 0,
    });
    return { ok: false, error: parsed.error, warnings: parsed.warnings, audit: row };
  }

  const intent = parsed.intent;
  const quote = live
    ? await liveQuote({ from: intent.from, to: intent.to, amount: intent.from.amount, slippageBps: intent.slippageBps })
    : snapshotQuote({ from: intent.from, to: intent.to, amount: intent.from.amount });

  // Reference price is independent of the quote, so a manipulated quote shows up
  // as a deviation instead of being trusted.
  const ref = referenceOut({ from: intent.from, to: intent.to, amount: intent.from.amount });
  const priced = {
    ...intent,
    notionalUsd: ref.usd,
    quotedOut: quote.amountOut,
    marketOut: ref.out,
  };

  const ctx = {
    ...rollingContext(audit.readAll()),
    knownAssets: assets.symbols(),
    knownChains: [...new Set(assets.all().map((t) => t.blockchain))],
  };
  const decision = evaluate(priced, policy, ctx);

  const row = audit.record({
    kind: "payment_intent",
    input: text,
    from: intent.from,
    to: intent.to,
    recipient: intent.recipient,
    notionalUsd: decision.notionalUsd,
    quoteSource: quote.source,
    amountOut: quote.amountOut,
    decision: decision.decision,
    reasons: decision.reasons,
    checks: decision.checks.map((c) => `${c.level}:${c.id}`),
  });

  return {
    ok: true,
    context: {
      spentTodayUsd: Number(ctx.spentTodayUsd.toFixed(2)),
      txCountLastHour: ctx.txCountLastHour,
      maxDailyUsd: decision.policyUsed.maxDailyUsd,
      maxTxPerHour: 6,
    },
    intent: priced,
    quote,
    reference: { out: Number(ref.out.toFixed(6)), priceFrom: ref.pFrom, priceTo: ref.pTo },
    decision,
    audit: row,
    assetMeta: assets.meta(),
    display: {
      from: `${intent.from.amount} ${intent.from.symbol}`,
      to: `${quote.amountOut} ${intent.to.symbol}`,
      notional: `$${decision.notionalUsd.toFixed(2)}`,
      recipient: intent.recipient ? short(intent.recipient) : "—",
    },
  };
}
