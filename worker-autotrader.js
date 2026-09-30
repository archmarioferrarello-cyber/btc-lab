// ============================================================================
// BTC Session Lab — AUTOTRADER (Cloudflare Worker)
// ----------------------------------------------------------------------------
// One free Worker that, every minute:
//   1. fetches BTC/USD 15m candles (free public APIs, no key)
//   2. computes the same signal as the web app (BTC, 15m)
//   3. opens / closes ONE position automatically
//   4. sends you a Telegram message on every open/close
//   5. serves a password-protected dashboard where you can watch it,
//      change risk/size, PAUSE/RESUME, or flatten the position.
//
// >>> DEFAULT MODE IS "paper": it trades a SIMULATED balance, moves NO real
//     money, and touches NO exchange account. This is on purpose. Read the
//     README before ever switching to live. <<<
//
// Bindings needed in the Cloudflare dashboard:
//   KV namespace  -> bind as  TRADE_KV
//   Secrets:  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DASH_TOKEN
//   Cron Trigger:  * * * * *   (every minute)
// ============================================================================

const SYMBOL = "BTC", TF_MIN = 15;
const PROD = { cb: "BTC-USD", okx: "BTC-USDT" };

function STRAT() {
  return {
    mode: "opens", windowMin: 120, sessions: { asia: true, london: true, ny: true }, weekend: true,
    trendFilter: true, requireFreshCross: false, freshBars: 6,
    rsiLongMin: 50, rsiLongMax: 72, rsiShortMin: 28, rsiShortMax: 50,
    volFilter: true, volMult: 1.0, flowFilter: true,
    atrMult: 1.5, rr: 1.2, maxHold: 96,
  };
}
// default TRADING settings (editable live from the dashboard, stored in KV)
function DEFAULT_SETTINGS() {
  return {
    paused: false,
    mode: "paper",              // "paper" (simulated) or "live" (real orders — see README)
    startBalance: 1000,         // paper starting balance in USD
    riskPct: 1.0,               // % of balance risked per trade (stop = 1R)
    maxPositionUsd: 500,        // hard cap on position notional
    feePct: 0.10,               // round-trip fee assumption (paper) / your taker fee (live)
    dailyLossStopPct: 5.0,      // auto-halt for the rest of the UTC day after this % daily loss
  };
}

// ------------------------- data fetch (free, no key) -------------------------
function fetchT(url, ms = 12000) {
  return Promise.race([fetch(url), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
}
function norm(a) { const m = new Map(); a.forEach(k => { if (k && isFinite(k.c) && isFinite(k.t)) m.set(k.t, k); }); return [...m.values()].sort((x, y) => x.t - y.t); }
async function fetchCoinbase() {
  const gran = TF_MIN * 60, per = 300, target = 600; let end = Math.floor(Date.now() / 1000); const all = [];
  for (let i = 0; i < 3 && all.length < target; i++) {
    const start = end - per * gran;
    const u = `https://api.exchange.coinbase.com/products/${PROD.cb}/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    const r = await fetchT(u); if (!r.ok) break;
    const d = await r.json(); if (!Array.isArray(d) || !d.length) break;
    d.forEach(x => all.push({ t: x[0] * 1000, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] }));
    end = start;
  }
  return norm(all);
}
async function fetchOKX() {
  const bar = TF_MIN + "m", target = 600; let after = Date.now(); const all = [];
  for (let i = 0; i < 3 && all.length < target; i++) {
    const u = `https://www.okx.com/api/v5/market/candles?instId=${PROD.okx}&bar=${bar}&limit=300&after=${after}`;
    const r = await fetchT(u); if (!r.ok) break;
    const j = await r.json(); const d = j.data || []; if (!d.length) break;
    d.forEach(x => all.push({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    after = Math.min(...d.map(x => +x[0]));
  }
  return norm(all);
}
async function fetchCandles() {
  try { const d = await fetchCoinbase(); if (d.length >= 150) return d; } catch (e) {}
  const d = await fetchOKX(); if (d.length >= 150) return d;
  throw new Error("Both Coinbase and OKX failed");
}

// ------------------------- indicators + signal (identical to app) -----------
function ema(v, n) { const k = 2 / (n + 1), o = new Array(v.length).fill(null); let p; for (let i = 0; i < v.length; i++) { p = p == null ? v[i] : v[i] * k + p * (1 - k); o[i] = p; } return o; }
function rsi(c, n = 14) { const o = new Array(c.length).fill(null); if (c.length <= n) return o; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / n, al = l / n; o[n] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al)); for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1], u = d > 0 ? d : 0, dn = d < 0 ? -d : 0; ag = (ag * (n - 1) + u) / n; al = (al * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al)); } return o; }
function atr(c, n = 14) { const tr = new Array(c.length).fill(null), o = new Array(c.length).fill(null); for (let i = 0; i < c.length; i++) tr[i] = i === 0 ? c[i].h - c[i].l : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (c.length <= n) return o; let a = 0; for (let i = 1; i <= n; i++) a += tr[i]; a /= n; o[n] = a; for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; o[i] = a; } return o; }
function vwap(c) { const o = new Array(c.length).fill(null); let day = null, pv = 0, vol = 0; for (let i = 0; i < c.length; i++) { const d = new Date(c[i].t).getUTCDate(); if (d !== day) { day = d; pv = 0; vol = 0; } const tp = (c[i].h + c[i].l + c[i].c) / 3; pv += tp * c[i].v; vol += c[i].v; o[i] = vol ? pv / vol : c[i].c; } return o; }
function sma(v, n) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
const minU = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
function inWindow(t, p) {
  const wd = new Date(t).getUTCDay(); if (p.weekend === false && (wd === 0 || wd === 6)) return false;
  if (p.mode === "always") return true;
  const m = minU(t), o = []; if (p.sessions.asia) o.push(0); if (p.sessions.london) o.push(420); if (p.sessions.ny) o.push(780);
  return o.some(x => { let d = m - x; if (d < 0) d += 1440; return d >= 0 && d < p.windowMin; });
}
function enrich(candles) {
  const close = candles.map(c => c.c);
  const flow = candles.map(c => { const r = c.h - c.l; return r > 0 ? ((c.c - c.l) - (c.h - c.c)) / r : 0; });
  return { candles, e9: ema(close, 9), e21: ema(close, 21), e50: ema(close, 50), r: rsi(close, 14), a: atr(candles, 14), vw: vwap(candles), volMA: sma(candles.map(c => c.v), 20), flow };
}
function checksFor(ctx, i, dir, p) {
  const { candles, e9, e21, e50, r, vw, volMA, flow } = ctx, c = candles[i], up = dir === "long", out = [];
  out.push(inWindow(c.t, p));
  out.push(up ? e9[i] > e21[i] : e9[i] < e21[i]);
  if (p.trendFilter) out.push(up ? e21[i] > e50[i] : e21[i] < e50[i]);
  if (p.requireFreshCross || p.mode === "always") { let fr = false; for (let k = Math.max(1, i - p.freshBars); k <= i; k++) { if (up && e9[k - 1] <= e21[k - 1] && e9[k] > e21[k]) fr = true; if (!up && e9[k - 1] >= e21[k - 1] && e9[k] < e21[k]) fr = true; } out.push(fr); }
  out.push(up ? c.c > vw[i] : c.c < vw[i]);
  out.push(up ? (r[i] >= p.rsiLongMin && r[i] <= p.rsiLongMax) : (r[i] >= p.rsiShortMin && r[i] <= p.rsiShortMax));
  if (p.volFilter) out.push(volMA[i] != null && c.v > volMA[i] * p.volMult);
  if (p.flowFilter) out.push(up ? flow[i] > 0 : flow[i] < 0);
  return out.every(Boolean);
}
function signalScore(ctx, i, dir) {
  const { candles: c, e9, e21, r, volMA, flow, a } = ctx, k = c[i], up = dir === "long"; let sc = 0;
  if (volMA[i] && k.v > volMA[i] * 1.3) sc++;
  if (Math.abs(flow[i]) >= 0.5) sc++;
  if (a[i] && Math.abs(e9[i] - e21[i]) >= 0.15 * a[i]) sc++;
  if (up ? (r[i] >= 55 && r[i] <= 68) : (r[i] >= 32 && r[i] <= 45)) sc++;
  return sc;
}
function liveSignal(ctx, p) {
  const i = ctx.candles.length - 2; if (i < 60) return null;
  for (const dir of ["long", "short"]) {
    if (checksFor(ctx, i, dir, p)) {
      const c = ctx.candles[i], av = ctx.a[i]; if (!av) continue;
      const risk = av * p.atrMult, entry = c.c;
      const stop = dir === "long" ? entry - risk : entry + risk;
      const target = dir === "long" ? entry + risk * p.rr : entry - risk * p.rr;
      return { dir, entry, stop, target, rr: p.rr, sc: signalScore(ctx, i, dir), entryTime: c.t };
    }
  }
  return null;
}

// ------------------------- Telegram -----------------------------------------
async function tg(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => {});
}
const fmt = (n, d = 1) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// ------------------------- KV state -----------------------------------------
async function kvGet(env, k, def) { try { const v = await env.TRADE_KV.get(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
async function kvPut(env, k, v) { try { await env.TRADE_KV.put(k, JSON.stringify(v)); } catch (e) {} }

// ------------------------- LIVE execution adapter ---------------------------
// Intentionally NOT wired to a real exchange out of the box. See README:
// "Going live". Paper mode is fully functional; live requires you to implement
// signed order placement for YOUR exchange and test it in tiny size first.
async function placeLiveOrder(env, side, sizeBtc, ref) {
  throw new Error("LIVE execution not configured. Bot stays in paper mode until you wire your exchange in placeLiveOrder(). See README.");
}

// ------------------------- core tick ----------------------------------------
async function runTick(env) {
  const st = Object.assign(DEFAULT_SETTINGS(), await kvGet(env, "settings", {}));
  let pos = await kvGet(env, "position", null);
  let bal = await kvGet(env, "balance", st.startBalance);
  let daily = await kvGet(env, "daily", null);
  const today = new Date().toISOString().slice(0, 10);
  if (!daily || daily.date !== today) { daily = { date: today, startBal: bal, realized: 0, halted: false }; }

  const candles = await fetchCandles();
  if (candles.length < 100) return "not enough candles";
  const ctx = enrich(candles);
  const lastClosed = candles[candles.length - 2];
  const px = candles[candles.length - 1].c;

  let note = [];

  // 1) manage an OPEN position: check stop/target against candles since entry
  if (pos) {
    let exit = null, reason = null;
    for (let j = 0; j < candles.length; j++) {
      const k = candles[j]; if (k.t <= pos.entryTime) continue;
      if (pos.dir === "long") {
        if (k.l <= pos.stop) { exit = pos.stop; reason = "stop"; break; }
        if (k.h >= pos.target) { exit = pos.target; reason = "target"; break; }
      } else {
        if (k.h >= pos.stop) { exit = pos.stop; reason = "stop"; break; }
        if (k.l <= pos.target) { exit = pos.target; reason = "target"; break; }
      }
      if ((k.t - pos.entryTime) >= STRAT().maxHold * TF_MIN * 60000) { exit = k.c; reason = "timeout"; break; }
    }
    if (exit != null) {
      const gross = (pos.dir === "long" ? (exit - pos.entry) : (pos.entry - exit)) * pos.sizeBtc;
      const fee = pos.sizeUsd * (st.feePct / 100);
      const pnl = gross - fee;
      bal += pnl; daily.realized += pnl;
      const trades = await kvGet(env, "trades", []);
      trades.unshift({ ...pos, exit, reason, pnl, closedAt: Date.now() });
      await kvPut(env, "trades", trades.slice(0, 50));
      if (st.mode === "live") { try { await placeLiveOrder(env, pos.dir === "long" ? "sell" : "buy", pos.sizeBtc, "close"); } catch (e) { note.push("LIVE close failed: " + e.message); } }
      await tg(env, `${reason === "target" ? "✅" : reason === "stop" ? "🛑" : "⌛"} <b>CLOSED ${pos.dir.toUpperCase()} ${SYMBOL}</b> @ ${fmt(exit)}\nP&L: <b>${pnl >= 0 ? "+" : ""}$${fmt(pnl, 2)}</b>  (${reason})\nBalance: $${fmt(bal, 2)}  [${st.mode}]`);
      pos = null;
    }
  }

  // 2) daily loss kill-switch
  const ddPct = (daily.realized / daily.startBal) * 100;
  if (!daily.halted && ddPct <= -st.dailyLossStopPct) {
    daily.halted = true;
    await tg(env, `⚠️ <b>Daily loss stop hit</b> (${fmt(ddPct, 1)}%). No new trades until tomorrow (UTC). [${st.mode}]`);
  }

  // 3) open a NEW position if flat, not paused, not halted, and a fresh signal exists
  if (!pos && !st.paused && !daily.halted) {
    const sig = liveSignal(ctx, STRAT());
    const lastId = await kvGet(env, "lastSignalId", null);
    if (sig && sig.entryTime !== lastId) {
      await kvPut(env, "lastSignalId", sig.entryTime);
      const riskUsd = bal * (st.riskPct / 100);
      const stopFrac = Math.abs(sig.entry - sig.stop) / sig.entry;
      let sizeUsd = Math.min(st.maxPositionUsd, bal, stopFrac > 0 ? riskUsd / stopFrac : 0);
      const sizeBtc = sizeUsd / sig.entry;
      if (sizeUsd > 5) {
        pos = { dir: sig.dir, entry: sig.entry, stop: sig.stop, target: sig.target, rr: sig.rr, sc: sig.sc, entryTime: sig.entryTime, sizeUsd, sizeBtc, openedAt: Date.now() };
        if (st.mode === "live") { try { await placeLiveOrder(env, sig.dir === "long" ? "buy" : "sell", sizeBtc, "open"); } catch (e) { note.push("LIVE open failed: " + e.message); pos = null; } }
        if (pos) {
          const stars = "★".repeat(sig.sc) + "☆".repeat(4 - sig.sc);
          await tg(env, `${sig.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} <b>${SYMBOL}/USD · 15m</b>  ${stars}\nEntry ${fmt(sig.entry)} · Stop ${fmt(sig.stop)} · Target ${fmt(sig.target)} (1:${sig.rr.toFixed(1)})\nSize: $${fmt(sizeUsd, 0)} (${sizeBtc.toFixed(5)} BTC) · risk ~$${fmt(riskUsd, 0)}\n[${st.mode}] balance $${fmt(bal, 2)}`);
        }
      }
    }
  }

  await kvPut(env, "position", pos);
  await kvPut(env, "balance", bal);
  await kvPut(env, "daily", daily);
  await kvPut(env, "lastPrice", { px, t: Date.now() });
  return `ok. price ${fmt(px)} pos ${pos ? pos.dir : "none"} bal ${fmt(bal, 2)} ${note.join("; ")}`;
}

// ------------------------- dashboard ----------------------------------------
function dashHTML(state) {
  const s = state.settings, pos = state.position, bal = state.balance, trades = state.trades || [], daily = state.daily || {};
  const pnlToday = daily.realized || 0;
  const posHtml = pos
    ? `<div class="pos ${pos.dir}"><b>${pos.dir.toUpperCase()}</b> · entry ${fmt(pos.entry)} · stop ${fmt(pos.stop)} · target ${fmt(pos.target)} · size $${fmt(pos.sizeUsd, 0)}</div>`
    : `<div class="pos flat">FLAT — no open position</div>`;
  const rows = trades.slice(0, 20).map(t => `<tr><td>${new Date(t.closedAt).toISOString().slice(5, 16).replace("T", " ")}</td><td class="${t.dir}">${t.dir}</td><td>${fmt(t.entry)}</td><td>${fmt(t.exit)}</td><td>${t.reason}</td><td class="${t.pnl >= 0 ? "pos" : "neg"}">${t.pnl >= 0 ? "+" : ""}$${fmt(t.pnl, 2)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC Autotrader</title>
<style>
body{background:#0E1116;color:#E6EBF2;font-family:system-ui,sans-serif;margin:0;padding:16px}
.wrap{max-width:760px;margin:0 auto}
.card{background:#151A22;border:1px solid #252D38;border-radius:12px;padding:14px;margin-bottom:12px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8A94A6;font-size:12px;font-family:ui-monospace,monospace}
.big{font-size:26px;font-weight:700;font-family:ui-monospace,monospace}
.pos{padding:10px;border-radius:8px;font-family:ui-monospace,monospace;font-size:13px}
.pos.long{background:rgba(61,214,160,.12);border:1px solid #3DD6A0}.pos.short{background:rgba(255,107,107,.12);border:1px solid #FF6B6B}.pos.flat{background:#1B212B;border:1px solid #252D38;color:#8A94A6}
button{cursor:pointer;background:#1B212B;border:1px solid #252D38;color:#E6EBF2;border-radius:8px;padding:9px 13px;font-size:13px;margin:3px}
button:hover{border-color:#E8B34A}button.danger{border-color:#FF6B6B;color:#FF6B6B}button.go{border-color:#3DD6A0;color:#3DD6A0}
input{background:#0E1116;border:1px solid #252D38;color:#E6EBF2;border-radius:8px;padding:8px;width:90px;font-family:ui-monospace,monospace}
label{font-size:12px;color:#8A94A6;display:inline-block;margin:6px 8px 6px 0}
table{width:100%;border-collapse:collapse;font-family:ui-monospace,monospace;font-size:12px}
td,th{text-align:left;padding:5px 8px;border-bottom:1px solid #252D38}
.long{color:#3DD6A0}.short{color:#FF6B6B}.pos{color:#3DD6A0}.neg{color:#FF6B6B}
.tag{display:inline-block;padding:3px 10px;border-radius:12px;font-family:ui-monospace,monospace;font-size:12px;font-weight:700}
.tag.paper{background:rgba(122,162,247,.15);color:#7AA2F7}.tag.live{background:rgba(255,107,107,.18);color:#FF6B6B}
.tag.run{background:rgba(61,214,160,.15);color:#3DD6A0}.tag.pause{background:rgba(232,179,74,.15);color:#E8B34A}
.warn{background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);border-radius:8px;padding:10px;font-size:12px;color:#FFB4B4;line-height:1.5}
</style></head><body><div class="wrap">
<div class="card"><h1>BTC Autotrader <span class="tag ${s.mode}">${s.mode.toUpperCase()}</span> <span class="tag ${s.paused ? "pause" : "run"}">${s.paused ? "PAUSED" : "RUNNING"}</span></h1>
<div class="sub">BTC/USD · 15m · updates every minute · last price ${state.lastPrice ? fmt(state.lastPrice.px) : "—"}</div></div>

<div class="card"><div class="sub">BALANCE (${s.mode})</div><div class="big">$${fmt(bal, 2)}</div>
<div class="sub">today P&L: <span class="${pnlToday >= 0 ? "pos" : "neg"}">${pnlToday >= 0 ? "+" : ""}$${fmt(pnlToday, 2)}</span>${daily.halted ? ' · <span class="neg">DAILY STOP HIT</span>' : ""}</div>
<div style="margin-top:10px">${posHtml}</div></div>

<div class="card"><div class="sub" style="margin-bottom:8px">CONTROLS</div>
<button class="${s.paused ? "go" : "danger"}" onclick="act('${s.paused ? "resume" : "pause"}')">${s.paused ? "▶ Resume" : "⏸ Pause"}</button>
<button class="danger" onclick="if(confirm('Close the open position now at market/next price?'))act('flatten')">✖ Flatten now</button>
<div style="margin-top:10px">
<label>Risk %/trade <input id="riskPct" value="${s.riskPct}"></label>
<label>Max position $ <input id="maxPositionUsd" value="${s.maxPositionUsd}"></label>
<label>Daily loss stop % <input id="dailyLossStopPct" value="${s.dailyLossStopPct}"></label>
<button onclick="saveSettings()">Save</button>
</div></div>

<div class="card"><div class="sub" style="margin-bottom:8px">RECENT TRADES</div>
<table><thead><tr><th>closed (UTC)</th><th>dir</th><th>entry</th><th>exit</th><th>why</th><th>P&L</th></tr></thead><tbody>${rows || '<tr><td colspan=6 style="color:#5A6373">no trades yet</td></tr>'}</tbody></table></div>

<div class="card"><div class="sub" style="margin-bottom:8px">MODE</div>
<button class="${s.mode === "paper" ? "go" : ""}" onclick="act('mode_paper')">Paper (simulated)</button>
<button class="danger" onclick="goLive()">Switch to LIVE</button>
<div class="warn" style="margin-top:10px">⚠️ Paper mode moves no real money. LIVE mode is disabled until you implement your exchange in <code>placeLiveOrder()</code> and set exchange secrets (see README). Do not go live until the strategy has proven positive in paper/forward testing — recent backtests have been negative.</div></div>

<div class="sub" style="text-align:center;margin-top:8px">Study tool, not financial advice. This dashboard is protected by your token — keep the URL private.</div>
</div>
<script>
const TOKEN=new URLSearchParams(location.search).get('token')||'';
async function act(a){await fetch('?token='+encodeURIComponent(TOKEN),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});location.reload();}
async function saveSettings(){
  const b={action:'settings',riskPct:+document.getElementById('riskPct').value,maxPositionUsd:+document.getElementById('maxPositionUsd').value,dailyLossStopPct:+document.getElementById('dailyLossStopPct').value};
  await fetch('?token='+encodeURIComponent(TOKEN),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});location.reload();
}
function goLive(){if(confirm('LIVE mode places REAL orders with REAL money on your exchange. Only do this after positive paper results and after wiring placeLiveOrder(). Continue?'))act('mode_live');}
</script></body></html>`;
}

// ------------------------- Worker entrypoints -------------------------------
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env).then(m => console.log(m)).catch(e => console.error("ERR", e.message)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!env.DASH_TOKEN || token !== env.DASH_TOKEN) return new Response("Unauthorized. Append ?token=YOUR_DASH_TOKEN", { status: 401 });

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const st = Object.assign(DEFAULT_SETTINGS(), await kvGet(env, "settings", {}));
      const a = body.action;
      if (a === "pause") st.paused = true;
      else if (a === "resume") st.paused = false;
      else if (a === "mode_paper") st.mode = "paper";
      else if (a === "mode_live") st.mode = "live";
      else if (a === "flatten") {
        const pos = await kvGet(env, "position", null);
        if (pos) { const lp = await kvGet(env, "lastPrice", { px: pos.entry }); const gross = (pos.dir === "long" ? (lp.px - pos.entry) : (pos.entry - lp.px)) * pos.sizeBtc; const fee = pos.sizeUsd * (st.feePct / 100); const pnl = gross - fee; let bal = await kvGet(env, "balance", st.startBalance); bal += pnl; await kvPut(env, "balance", bal); const trades = await kvGet(env, "trades", []); trades.unshift({ ...pos, exit: lp.px, reason: "manual", pnl, closedAt: Date.now() }); await kvPut(env, "trades", trades.slice(0, 50)); await kvPut(env, "position", null); await tg(env, `✖ <b>Manually flattened</b> ${pos.dir.toUpperCase()} @ ${fmt(lp.px)} · P&L ${pnl >= 0 ? "+" : ""}$${fmt(pnl, 2)}`); }
      }
      else if (a === "settings") {
        if (isFinite(body.riskPct)) st.riskPct = Math.max(0.1, Math.min(10, body.riskPct));
        if (isFinite(body.maxPositionUsd)) st.maxPositionUsd = Math.max(5, body.maxPositionUsd);
        if (isFinite(body.dailyLossStopPct)) st.dailyLossStopPct = Math.max(0.5, Math.min(50, body.dailyLossStopPct));
      }
      await kvPut(env, "settings", st);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // GET: run a tick opportunistically (so opening the dashboard also refreshes), then render
    let tickMsg = "";
    try { tickMsg = await runTick(env); } catch (e) { tickMsg = "tick error: " + e.message; }
    const state = {
      settings: Object.assign(DEFAULT_SETTINGS(), await kvGet(env, "settings", {})),
      position: await kvGet(env, "position", null),
      balance: await kvGet(env, "balance", DEFAULT_SETTINGS().startBalance),
      trades: await kvGet(env, "trades", []),
      daily: await kvGet(env, "daily", {}),
      lastPrice: await kvGet(env, "lastPrice", null),
    };
    return new Response(dashHTML(state), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
