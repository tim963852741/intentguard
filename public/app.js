const EXAMPLES = [
  "把 0.5 ETH 换成 USDC，滑点 1%",
  "swap 120 USDC to NEAR",
  "把 2000 USDC 换成 ETH",
  "换 0.1 WBTC 成 USDC，滑点 3%",
  "把 0.02 ETH 换成 USDC，收款人 0x9f3a1c4b7d2e5f6081a2b3c4d5e6f708192a3b4c",
];

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function renderExamples() {
  const box = $("#examples");
  box.innerHTML = "";
  for (const e of EXAMPLES) {
    const c = el("span", "chip", e);
    c.onclick = () => { $("#intent").value = e; };
    box.appendChild(c);
  }
}

async function loadMeta() {
  const r = await fetch("/api/assets");
  const d = await r.json();
  $("#meta").textContent = `${d.meta.count} assets · ${d.meta.source}`;
}

async function loadAudit() {
  const r = await fetch("/api/audit");
  const d = await r.json();
  const body = $("#audit tbody");
  body.innerHTML = "";
  for (const row of d.rows) {
    const tr = el("tr");
    tr.appendChild(el("td", "mono", String(row.seq)));
    tr.appendChild(el("td", "mono", new Date(row.at).toLocaleTimeString()));
    tr.appendChild(el("td", "", row.input ?? "—"));
    tr.appendChild(el("td", "", row.notionalUsd ? `$${Number(row.notionalUsd).toFixed(2)}` : "—"));
    const td = el("td");
    td.appendChild(el("span", `tag ${row.decision}`, row.decision));
    tr.appendChild(td);
    tr.appendChild(el("td", "", (row.reasons && row.reasons[0]) || "—"));
    tr.appendChild(el("td", "mono", (row.hash || "").slice(0, 10)));
    body.appendChild(tr);
  }
  const badge = $("#chain");
  badge.textContent = d.verify.ok ? `chain: ${d.verify.length} records verified` : `chain broken @${d.verify.brokenAt}`;
  badge.classList.toggle("bad", !d.verify.ok);
}

function renderResult(d) {
  const box = $("#result");
  box.hidden = false;
  box.innerHTML = "";

  const head = el("div", "head");
  head.appendChild(el("span", `decision ${d.decision.decision}`, d.decision.decision));
  head.appendChild(el("span", "summary", d.decision.summary));
  box.appendChild(head);

  const nums = el("div", "numbers");
  const add = (v, k) => {
    const n = el("div", "num");
    const b = el("b", "", v);
    n.appendChild(b);
    n.appendChild(el("small", "", k));
    nums.appendChild(n);
  };
  add(d.display.from, "you send");
  add(d.display.to, "agent receives");
  add(d.display.notional, "notional");
  add(d.display.recipient, "recipient");
  box.appendChild(nums);

  if (d.decision.reasons.length) {
    const ul = el("ul", "reasons");
    for (const r of d.decision.reasons) ul.appendChild(el("li", "", r));
    box.appendChild(ul);
  }

  const checks = el("div", "checks");
  for (const c of d.decision.checks) {
    checks.appendChild(el("span", `check ${c.level}`, `${c.id} · ${c.message}`));
  }
  box.appendChild(checks);

  if (d.context) {
    const c = el("div", "note",
      `rolling window: $${d.context.spentTodayUsd} spent in 24h (cap $${d.context.maxDailyUsd}) · ` +
      `${d.context.txCountLastHour} payments in the last hour (cap ${d.context.maxTxPerHour})`);
    box.appendChild(c);
  }

  const note = el("div", "note",
    `quote source: ${d.quote.source} · route ${d.quote.route} · reference ${d.reference.out} ${d.intent.to.symbol}` +
    (d.quote.note ? ` · ${d.quote.note}` : ""));
  box.appendChild(note);
}

async function evaluate() {
  const text = $("#intent").value.trim();
  if (!text) return;
  $("#go").disabled = true;
  try {
    const r = await fetch("/api/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, live: $("#live").checked }),
    });
    const d = await r.json();
    if (!d.ok) {
      const box = $("#result");
      box.hidden = false;
      box.innerHTML = "";
      const head = el("div", "head");
      head.appendChild(el("span", "decision DENY", "DENY"));
      head.appendChild(el("span", "summary", d.error));
      box.appendChild(head);
    } else {
      renderResult(d);
    }
    await loadAudit();
  } finally {
    $("#go").disabled = false;
  }
}

renderExamples();
loadMeta();
loadAudit();
$("#go").onclick = evaluate;
$("#reset").onclick = async () => {
  await fetch("/api/reset", { method: "POST" });
  $("#result").hidden = true;
  await loadAudit();
};
$("#intent").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") evaluate();
});
