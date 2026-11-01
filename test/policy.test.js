import test from "node:test";
import assert from "node:assert/strict";

import { evaluate, ALLOW, APPROVAL, DENY } from "../src/policy.js";
import { parseIntent, parseSlippage, parseRecipient } from "../src/agent.js";
import * as assets from "../src/assets.js";

const TRUSTED = "0x1111111111111111111111111111111111111111";
const POLICY = { recipientAllowlist: [TRUSTED], maxPerTxUsd: 500, maxDailyUsd: 1500, maxTxPerHour: 6, maxSlippageBps: 150 };

const base = {
  from: { symbol: "ETH", amount: 0.1, chain: "near" },
  to: { symbol: "USDC", chain: "near" },
  recipient: TRUSTED,
  slippageBps: 100,
  notionalUsd: 227,
  quotedOut: 226,
  marketOut: 227,
};

test("routine payment is allowed", () => {
  const d = evaluate(base, POLICY, {});
  assert.equal(d.decision, ALLOW);
  assert.equal(d.reasons.length, 0);
});

test("per-transaction cap blocks a large payment", () => {
  const d = evaluate({ ...base, notionalUsd: 2270 }, POLICY, {});
  assert.equal(d.decision, DENY);
  assert.ok(d.reasons.some((r) => r.includes("per-transaction cap")));
});

test("dust below the floor is refused", () => {
  const d = evaluate({ ...base, notionalUsd: 0.2 }, POLICY, {});
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "dust"));
});

test("daily cap counts what was already spent", () => {
  const d = evaluate({ ...base, notionalUsd: 400 }, POLICY, { spentTodayUsd: 1300 });
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "daily_cap"));
});

test("velocity limit catches a runaway loop", () => {
  const d = evaluate(base, POLICY, { txCountLastHour: 6 });
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "velocity"));
});

test("unknown recipient is held, not silently allowed", () => {
  const d = evaluate({ ...base, recipient: "0x2222222222222222222222222222222222222222" }, POLICY, {});
  assert.equal(d.decision, APPROVAL);
  assert.ok(d.checks.some((c) => c.id === "unknown_recipient"));
});

test("slippage beyond policy is blocked", () => {
  const d = evaluate({ ...base, slippageBps: 500 }, POLICY, {});
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "slippage"));
});

test("quote deviating from reference price is blocked", () => {
  const d = evaluate({ ...base, quotedOut: 180, marketOut: 227 }, POLICY, {});
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "price_deviation"));
});

test("same asset on both legs is refused", () => {
  const d = evaluate({ ...base, to: { symbol: "ETH", chain: "near" } }, POLICY, {});
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "same_asset"));
});

test("missing price refuses to sign", () => {
  const d = evaluate({ ...base, notionalUsd: 0 }, POLICY, {});
  assert.equal(d.decision, DENY);
  assert.ok(d.checks.some((c) => c.id === "notional_missing"));
});

test("parser reads a Chinese swap sentence", () => {
  const p = parseIntent("把 0.5 ETH 换成 USDC，滑点 1%，收款人 0x1111111111111111111111111111111111111111");
  assert.equal(p.ok, true);
  assert.equal(p.intent.from.symbol, "ETH");
  assert.equal(p.intent.from.amount, 0.5);
  assert.equal(p.intent.to.symbol, "USDC");
  assert.equal(p.intent.slippageBps, 100);
  assert.equal(p.intent.recipient, "0x1111111111111111111111111111111111111111");
});

test("parser reads an English swap sentence", () => {
  const p = parseIntent("swap 120 USDC to NEAR");
  assert.equal(p.ok, true);
  assert.equal(p.intent.from.symbol, "USDC");
  assert.equal(p.intent.from.amount, 120);
  assert.equal(p.intent.to.symbol, "NEAR");
});

test("parser refuses a one-legged intent instead of guessing", () => {
  const p = parseIntent("send 5 ETH");
  assert.equal(p.ok, false);
  assert.match(p.error, /one leg|destination/i);
});

test("parser tolerates a measure word between amount and asset", () => {
  const p = parseIntent("把 5 个 ETH 转给 alice.near");
  assert.equal(p.ok, false); // no destination asset
  assert.match(p.error, /one leg|destination/i);
  const q = parseIntent("把 5 个 ETH 换成 USDC");
  assert.equal(q.ok, true);
  assert.equal(q.intent.from.amount, 5);
});

test("slippage and recipient helpers", () => {
  assert.equal(parseSlippage("滑点 0.5%"), 50);
  assert.equal(parseSlippage("slippage 2%"), 200);
  assert.equal(parseRecipient("to alice.near"), "alice.near");
  assert.equal(parseRecipient("no address here"), null);
});

test("registry has prices for the demo assets", () => {
  for (const s of ["ETH", "USDC", "NEAR"]) {
    assert.ok(assets.priceOf(s) > 0, `${s} should have a price`);
  }
});

test("base-unit conversion round-trips", () => {
  const base = assets.toBaseUnits(0.5, "ETH");
  assert.equal(assets.fromBaseUnits(base, "ETH"), 0.5);
});
