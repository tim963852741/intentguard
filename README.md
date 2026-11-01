# IntentGuard

**Spend limits for AI agents that hold wallets.**

An agent with a private key will eventually do something expensive at 3am, and it will be able to explain exactly why. IntentGuard sits between the agent and the money: every payment intent is parsed, priced, checked against hard limits, and written to a tamper-evident log **before** it can reach NEAR Intents.

The design principle is boring on purpose: the policy engine is a set of pure functions with no network access and no model calls. A guardrail you cannot unit-test is not a guardrail.

```
agent → natural language intent → parse → price (1Click quote) → policy gate → audit log → sign
                                        ↑                        ↑
                                  refuses to guess        ALLOW / REQUIRE_APPROVAL / DENY
```

Track: **AI Security & Defense** — *make AI-controlled money safer with spending limits, wallet safeguards and scam detection.*

---

## Try it in 60 seconds

```bash
git clone <this repo> && cd intentguard
npm test          # 17 tests, no dependencies, no network
npm run demo      # 7 scenarios through the real pipeline
npm start         # http://localhost:5177
```

No `npm install` is required — the project has zero runtime dependencies.

### Do X, see Y

| Do this | Expect this |
| --- | --- |
| `npm test` | `# pass 17` `# fail 0` |
| `npm run demo` | 7 rows; `ALLOW 1 · REQUIRE_APPROVAL 1 · DENY 5`, then `audit chain: OK (13 records, hash-linked)` |
| `npm start`, then open `http://localhost:5177` | A form pre-filled with `把 0.5 ETH 换成 USDC，滑点 1%` |
| Click **Evaluate** | A red `DENY` card: `$1136.41 exceeds the per-transaction cap of $500` |
| Change the text to `把 0.1 ETH 换成 USDC，收款人 0x1111…1111` and evaluate | Green `ALLOW`: notional ≈ `$227.28` |
| Change the recipient to `0x2222…2222` | Amber `REQUIRE_APPROVAL`: recipient not on the allowlist |
| Change the amount to `0.0001 ETH` | `DENY` — below the `$1` floor, flagged as an address-poisoning probe |
| Tick **use live 1Click quote** and evaluate | Quote card shows `quote source: live`; on a slow network it degrades to `snapshot` and says so |
| Click **reset log**, then evaluate again | The rolling window returns to `$0 spent in 24h · 0 payments in the last hour` and the same input reproduces the same decision |

Every evaluation appends a row to the audit table at the bottom, and the badge above it re-verifies the hash chain on every load.

One counterparty (`0x1111…1111`) is pre-approved in the UI's demo policy so the happy path is visible immediately; every other address is unknown and gets held for approval. The rolling window is real — the same sentence can be `ALLOW` at 09:00 and `DENY` at 09:05 once six payments have gone through. That is the feature, not a bug: press **reset log** to put the window back to zero.

---

## What it actually guards

| Rule | Blocks | Why it exists |
| --- | --- | --- |
| `per_tx_cap` | one payment above `$500` | the single mistake that hurts |
| `daily_cap` | cumulative spend above `$1500`/24h | slow bleed across many small payments |
| `velocity` | more than 6 payments/hour | the signature of an agent stuck in a retry loop |
| `dust` | notional below `$1` | address-poisoning and typo probes |
| `slippage` | slippage above 150 bps | sandwich targets |
| `price_deviation` | quote more than 200 bps off a reference price | a malicious or stale route |
| `unknown_recipient` | first payment to an address not on the allowlist | the human-in-the-loop checkpoint |
| `unknown_asset` / `chain_not_allowed` | assets or chains outside the registry | scope creep |
| `notional_missing` | anything that cannot be priced | never sign blind |
| `malformed_intent` / one-leg intent | sentences the parser cannot read | refuse instead of guessing |

The engine returns one of three decisions. `DENY` is final. `REQUIRE_APPROVAL` means a human must approve this specific recipient once. `ALLOW` means it passed everything — and the reason is recorded, not inferred later.

## Why deterministic

Most "AI safety" layers for agents are another model judging the first model. That is unauditable: when a payment goes wrong you cannot replay the judge. Every rule here is a pure function of `(intent, policy, context)`:

```js
evaluate(intent, policy, ctx) → { decision, checks, reasons, summary }
```

Same inputs, same output, forever. That is what makes `npm test` meaningful and what makes the audit log evidence rather than a diary.

## The audit log is a hash chain

`src/audit.js` writes one JSON line per decision, each carrying the SHA-256 hash of the previous record. `verify()` recomputes the chain and reports the first broken link, so editing or deleting history is detectable:

```bash
curl localhost:5177/api/audit | jq '.verify'
# { "ok": true, "length": 13 }
```

That matters when the question is not "what did the agent do" but "prove it".

## NEAR integration

| Piece | Where | What it does |
| --- | --- | --- |
| **NEAR Intents / 1Click** | `src/quotes.js` | `POST /v0/quote` with `dry: true` — a real executable route with no funds moved and no wallet needed. The live quote is compared against an independent reference price; a deviation beyond policy is a hard `DENY`. |
| **1Click token registry** | `src/assets.js` | `/v0/tokens` is the source of truth for `assetId`, decimals, chain and USD price. Bundled as `fixtures/tokens.snapshot.json` (real data) so the demo runs offline; `POST /api/refresh` pulls live. |
| **Base-unit conversion** | `src/assets.js` | decimals-aware `BigInt` maths — 24-decimal wNEAR will not silently round. |

Deliberately **not** in scope for this prototype: signing. The gate returns `depositAddress` and the full route so the next step is a normal Intents deposit; keeping the signing key out of the prototype is the point of the layer.

### Live vs snapshot, always labelled

Neutering a quote is easy; pretending it is live is not. Every quote carries `source: "live" | "snapshot"`, and the UI prints it. When the API is unreachable the system degrades to the bundled snapshot **and says so** — silently falling back to a stale price would be exactly the failure mode this project exists to prevent.

## Project layout

```
src/policy.js     pure rule engine (no I/O)
src/agent.js      natural-language intent parser (zh + en)
src/quotes.js     1Click adapter with snapshot fallback
src/assets.js     token registry + decimals-safe maths
src/audit.js      append-only hash-chained log
src/pipeline.js   text → quote → decision → audit
src/server.js     zero-dependency HTTP API + static UI
public/           single-page UI
demo/run-demo.js  7 scenarios
test/             17 unit tests (node:test)
```

## API

```
POST /api/intent   { "text": "把 0.1 ETH 换成 USDC", "live": false, "policy": {} }
POST /api/parse    { "text": "..." }        → parsed intent only
GET  /api/assets                             → registry + source
GET  /api/audit                              → rows + chain verification
POST /api/refresh                            → pull live 1Click tokens
POST /api/reset                              → truncate the audit log (demo convenience)
```

## Limitations, stated plainly

- **The prototype does not sign.** It decides and logs; execution is a separate step by design.
- **The parser is rule-based.** It handles the phrasings in `demo/` and returns an explicit error otherwise. An LLM fallback would improve recall and destroy replayability, so it is not here.
- **The reference price is the registry snapshot.** A production build would use a median across several sources; a single reference can itself be wrong.
- **`REQUIRE_APPROVAL` is a state, not a UI.** There is no approval inbox yet — the decision is recorded, the human workflow is the next milestone.
- **Policy is per-call, not per-agent.** Multi-tenant policy storage and signed policy versions are the obvious next step.

## Roadmap

1. Approval inbox: one-tap human sign-off for `REQUIRE_APPROVAL`, replaying the exact recorded intent.
2. Signed policy bundles so an auditor can verify which rules were in force at decision time.
3. Reputation: score recipients and routes across agents, feeding `unknown_recipient`.
4. Real execution path via Intents `depositAddress` + a separate, hardware-held signer.

## License

MIT
