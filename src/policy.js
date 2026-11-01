// The policy engine. Pure functions only: same intent + same policy + same context
// always produces the same decision. That property is the whole point — an agent's
// spend must be auditable after the fact, and testable before it.

export const ALLOW = "ALLOW";
export const APPROVAL = "REQUIRE_APPROVAL";
export const DENY = "DENY";

export const DEFAULT_POLICY = {
  maxPerTxUsd: 500,
  maxDailyUsd: 1500,
  maxTxPerHour: 6,
  minNotionalUsd: 1,
  maxSlippageBps: 150,
  maxPriceDeviationBps: 200,
  allowedChains: ["near", "eth", "sol", "bsc", "pol", "arbitrum", "base"],
  allowedAssets: null, // null = all registry assets
  recipientAllowlist: [],
  requireKnownRecipient: true,
  blockUnknownAssets: true,
};

// The UI ships with one pre-approved counterparty so the happy path is visible
// without a setup step. Everything else stays unknown → REQUIRE_APPROVAL.
export const DEMO_POLICY = {
  ...DEFAULT_POLICY,
  recipientAllowlist: ["0x1111111111111111111111111111111111111111"],
};

const LEVEL = { deny: 3, approval: 2, info: 1 };

function push(checks, id, level, message, detail) {
  checks.push({ id, level, message, ...(detail ? { detail } : {}) });
}

/**
 * @param {object} intent  { from:{symbol,amount,chain}, to:{symbol,chain}, recipient, slippageBps, notionalUsd, quotedOut, marketOut }
 * @param {object} policy  see DEFAULT_POLICY
 * @param {object} ctx     { spentTodayUsd, txCountLastHour, knownAssets:[symbol], knownChains:[chain] }
 */
export function evaluate(intent, policy = {}, ctx = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const checks = [];
  const notional = Number(intent.notionalUsd ?? 0);

  // 1. Direction sanity — a swap must have two distinct legs.
  if (!intent.from || !intent.to || !intent.from.symbol || !intent.to.symbol) {
    push(checks, "malformed_intent", "deny", "intent is missing a leg", { intent });
    return finish(checks, p, notional, 0);
  }
  if (
    intent.from.symbol.toUpperCase() === intent.to.symbol.toUpperCase() &&
    (intent.from.chain || "") === (intent.to.chain || "")
  ) {
    push(checks, "same_asset", "deny", "source and destination are the same asset on the same chain");
    return finish(checks, p, notional, 0);
  }

  // 2. Asset + chain allowlists.
  if (p.blockUnknownAssets && Array.isArray(ctx.knownAssets) && ctx.knownAssets.length > 0) {
    for (const leg of [intent.from, intent.to]) {
      if (!ctx.knownAssets.map((s) => s.toUpperCase()).includes(leg.symbol.toUpperCase())) {
        push(checks, "unknown_asset", "deny", `asset not in registry: ${leg.symbol}`);
      }
    }
  }
  if (p.allowedAssets) {
    const allowed = p.allowedAssets.map((s) => s.toUpperCase());
    for (const leg of [intent.from, intent.to]) {
      if (!allowed.includes(leg.symbol.toUpperCase())) {
        push(checks, "asset_not_allowed", "deny", `${leg.symbol} is not on the allowlist`);
      }
    }
  }
  for (const leg of [intent.from, intent.to]) {
    if (leg.chain && !p.allowedChains.includes(leg.chain)) {
      push(checks, "chain_not_allowed", "deny", `chain ${leg.chain} is outside the allowlist`);
    }
  }

  // 3. Size, in USD. Everything downstream reasons in one unit.
  if (!(notional > 0)) {
    push(checks, "notional_missing", "deny", "could not price this intent, refusing to sign blind");
    return finish(checks, p, notional, 0);
  }
  if (notional < p.minNotionalUsd) {
    push(checks, "dust", "deny", `notional $${notional.toFixed(2)} is below the $${p.minNotionalUsd} floor — likely a mistake or an address-poisoning probe`);
  }
  if (notional > p.maxPerTxUsd) {
    push(checks, "per_tx_cap", "deny", `$${notional.toFixed(2)} exceeds the per-transaction cap of $${p.maxPerTxUsd}`);
  }

  // 4. Rolling windows.
  const spent = Number(ctx.spentTodayUsd ?? 0);
  const dailyAfter = spent + notional;
  if (dailyAfter > p.maxDailyUsd) {
    push(checks, "daily_cap", "deny", `daily spend would reach $${dailyAfter.toFixed(2)}, cap $${p.maxDailyUsd}`, { spent, notional });
  } else if (dailyAfter > p.maxDailyUsd * 0.8) {
    push(checks, "daily_cap_warn", "info", `daily spend at ${((dailyAfter / p.maxDailyUsd) * 100).toFixed(0)}% of cap`);
  }
  const count = Number(ctx.txCountLastHour ?? 0);
  if (count >= p.maxTxPerHour) {
    push(checks, "velocity", "deny", `${count} payments in the last hour, limit ${p.maxTxPerHour} — this is the shape of a runaway loop`);
  }

  // 5. Execution quality.
  const slip = Number(intent.slippageBps ?? 0);
  if (slip > p.maxSlippageBps) {
    push(checks, "slippage", "deny", `slippage ${slip}bps exceeds ${p.maxSlippageBps}bps`);
  }
  if (intent.quotedOut && intent.marketOut) {
    const dev = Math.abs(intent.quotedOut - intent.marketOut) / intent.marketOut * 10000;
    if (dev > p.maxPriceDeviationBps) {
      push(checks, "price_deviation", "deny",
        `quote deviates ${dev.toFixed(0)}bps from reference price`, { quoted: intent.quotedOut, market: intent.marketOut });
    }
  }

  // 6. Counterparty.
  const to = String(intent.recipient || "").trim();
  if (!to) {
    push(checks, "no_recipient", "deny", "no recipient was specified");
  } else if (p.requireKnownRecipient && !p.recipientAllowlist.includes(to)) {
    push(checks, "unknown_recipient", "approval", `recipient ${short(to)} is not on the allowlist — needs a human to approve once`);
  }

  return finish(checks, p, notional, slip);
}

function finish(checks, policy, notional, slippageBps) {
  const worst = checks.reduce((acc, c) => Math.max(acc, LEVEL[c.level] ?? 0), 0);
  const decision = worst >= LEVEL.deny ? DENY : worst >= LEVEL.approval ? APPROVAL : ALLOW;
  const blocking = checks.filter((c) => c.level === "deny");
  const needing = checks.filter((c) => c.level === "approval");
  return {
    decision,
    checks,
    reasons: [...blocking, ...needing].map((c) => c.message),
    summary: summarize(decision, blocking, needing, notional),
    notionalUsd: Number(notional.toFixed(2)),
    policyUsed: {
      maxPerTxUsd: policy.maxPerTxUsd,
      maxDailyUsd: policy.maxDailyUsd,
      maxSlippageBps: policy.maxSlippageBps,
    },
    slippageBps,
  };
}

function summarize(decision, blocking, needing, notional) {
  if (decision === DENY) return `blocked: ${blocking[0]?.message ?? "policy violation"}`;
  if (decision === APPROVAL) return `held for approval: ${needing[0]?.message ?? "human sign-off required"}`;
  return `allowed: $${notional.toFixed(2)} inside every limit`;
}

function short(addr) {
  const a = String(addr);
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export { short };
