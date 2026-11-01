// Six scenarios, run against the real pipeline. No mocks: the same code path the
// server uses. Run `npm run demo`.

import * as audit from "../src/audit.js";
import { run } from "../src/pipeline.js";

const TRUSTED = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";

const POLICY = {
  maxPerTxUsd: 500,
  maxDailyUsd: 1500,
  maxTxPerHour: 6,
  maxSlippageBps: 150,
  recipientAllowlist: [TRUSTED],
  requireKnownRecipient: true,
};

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function line(r) {
  const d = r.ok ? r.decision.decision : "DENY";
  const reason = r.ok ? (r.decision.reasons[0] ?? r.decision.summary) : r.error;
  return { d, reason, notional: r.ok ? r.decision.notionalUsd : 0 };
}

function print(i, label, text, r) {
  const { d, reason, notional } = line(r);
  console.log(
    `${pad(i, 3)} ${pad(label, 22)} ${pad(text.slice(0, 46), 46)} ${padL("$" + notional.toFixed(2), 9)}  ${pad(d, 17)} ${reason}`
  );
}

async function main() {
  audit.reset();
  console.log("\nIntentGuard — policy scenarios\n");
  console.log(`${pad("#", 3)} ${pad("scenario", 22)} ${pad("intent", 46)} ${padL("notional", 9)}  ${pad("decision", 17)} reason`);
  console.log("-".repeat(140));

  let i = 0;
  const results = [];

  // 1. routine payment inside every limit
  let r = await run(`把 0.1 ETH 换成 USDC，滑点 1%，收款人 ${TRUSTED}`, { policy: POLICY });
  print(++i, "routine", "0.1 ETH → USDC", r); results.push(r);

  // 2. a single payment over the per-tx cap
  r = await run(`把 1 ETH 换成 USDC，收款人 ${TRUSTED}`, { policy: POLICY });
  print(++i, "over per-tx cap", "1 ETH → USDC", r); results.push(r);

  // 3. dust — the classic address-poisoning probe
  r = await run(`把 0.0001 ETH 换成 USDC，收款人 ${TRUSTED}`, { policy: POLICY });
  print(++i, "dust probe", "0.0001 ETH → USDC", r); results.push(r);

  // 4. unknown counterparty → held for a human
  r = await run(`把 0.1 ETH 换成 USDC，收款人 ${STRANGER}`, { policy: POLICY });
  print(++i, "unknown recipient", "0.1 ETH → USDC", r); results.push(r);

  // 5. slippage beyond policy
  r = await run(`把 0.1 ETH 换成 USDC，滑点 5%，收款人 ${TRUSTED}`, { policy: POLICY });
  print(++i, "slippage too high", "0.1 ETH → USDC @5%", r); results.push(r);

  // 6. a runaway loop: six payments land, the seventh is refused
  const loopPolicy = { ...POLICY, maxDailyUsd: 1_000_000 };
  console.log("\n    (seeding 6 allowed payments to build up velocity...)");
  for (let n = 0; n < 6; n++) {
    await run(`把 0.05 ETH 换成 USDC，收款人 ${TRUSTED}`, { policy: loopPolicy });
  }
  r = await run(`把 0.05 ETH 换成 USDC，收款人 ${TRUSTED}`, { policy: loopPolicy });
  print(++i, "runaway loop (7th)", "0.05 ETH → USDC", r); results.push(r);

  // 7. an ambiguous sentence — the parser refuses instead of guessing a destination
  r = await run("把 5 个 ETH 转给 alice.near", { policy: POLICY });
  print(++i, "ambiguous intent", "5 ETH 转给 alice.near", r); results.push(r);

  const counts = results.reduce((acc, x) => {
    const d = x.ok ? x.decision.decision : "DENY";
    acc[d] = (acc[d] ?? 0) + 1;
    return acc;
  }, {});

  console.log("-".repeat(140));
  console.log(
    `\n${results.length} intents · ALLOW ${counts.ALLOW ?? 0} · REQUIRE_APPROVAL ${counts.REQUIRE_APPROVAL ?? 0} · DENY ${counts.DENY ?? 0}`
  );

  const v = audit.verify();
  console.log(`audit chain: ${v.ok ? `OK (${v.length} records, hash-linked)` : `BROKEN at ${v.brokenAt}`}`);
  console.log(`audit file : data/audit.jsonl\n`);
}

main();
