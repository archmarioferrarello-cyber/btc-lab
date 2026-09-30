// BTC Session Lab — Telegram notifier (Cloudflare Worker) — FINAL, 15m only
// Runs on a Cron Trigger every 1 minute. Paste this whole file into the
// Cloudflare Worker editor (btc-lab-alert) and Deploy.
//
// Needs (Settings → Variables / Bindings):
//   Secrets:  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   KV binding: BTC_STATE   (reuses your existing namespace — no rebind needed)
//   Trigger: Cron Trigger  *  *  *  *  *   (every minute)
//
// Locked to BTC/USD, 15-minute candles only. Same strategy defaults as the app
// and the package (R:R 1.2, ATR x1.5, sessions on, weekend on).

const SYM = {
  BTC: { cb: "BTC-USD", okx: "BTC-USDT" },
};

function P() {
  return {
    mode: "opens", windowMin: 120, sessions: { asia: true, london: true, ny: true }, weekend: true,
    trendFilter: true, requireFreshCross: false, freshBars: 6,
    rsiLongMin: 50, rsiLongMax: 72, rsiShortMin: 28, rsiShortMax: 50,
    volFilter: true, volMult: 1.0, flowFilter: true,
    atrMult: 1.5, rr: 1.2, maxHold: 96,
  };
}

// ---------- fetch (Coinbase primary, OKX fallback — both free, no key) ----------
function fetchT(url, ms = 12000) {
  return Promise.race([fetch(url), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
function norm(a) {
  const m = new Map();
  a.forEach(k => { if (k && isFinite(k.c) && isFinite(k.t)) m.set(k.t, k); });
  return [...m.values()].sort((x, y) => x.t - y.t);
}
async function fetchCoinbase(sym, tfMin) {
  const gran = tfMin * 60, per = 300, target = 600;
  let end = Math.floor(Date.now() / 1000); const all = [];
  for (let i = 0; i < 3 && all.length < target; i++) {
    const start = end - per * gran;
    const u = `https://api.exchange.coinbase.com/products/${sym.cb}/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    const r = await fetchT(u);
    if (!r.ok) break;
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    d.forEach(x => all.push({ t: x[0] * 1000, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] }));
    end = start;
  }
  return norm(all);
}
async function fetchOKX(sym, tfMin) {
  const bar = tfMin + "m", target = 600;
  let after = Date.now(); const all = [];
  for (let i = 0; i < 3 && all.length < target; i++) {
    const u = `https://www.okx.com/api/v5/market/candles?instId=${sym.okx}&bar=${bar}&limit=300&after=${after}`;
    const r = await fetchT(u);
    if (!r.ok) break;
    const j = await r.json(); const d = j.data || [];
    if (!d.length) break;
    d.forEach(x => all.push({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    after = Math.min(...d.map(x => +x[0]));
  }
  return norm(all);
}
async function fetchCandles(sym, tfMin) {
  try { const d = await fetchCoinbase(sym, tfMin); if (d.length >= 150) return d; } catch (e) { /* fallthrough */ }
  const d = await fetchOKX(sym, tfMin); if (d.length >= 150) return d;
  throw new Error("Both Coinbase and OKX failed or returned too little data");
}

// ---------- indicators (identical math to the web app) ----------
// @ts-ignore
function ema(v, n) { const k = 2 / (n + 1), o = new Array(v.length).fill(null); let p; for (let i = 0; i < v.length; i++) { p = p == null ? v[i] : v[i] * k + p * (1 - k); o[i] = p; } return o; }
function rsi(c, n = 14) { const o = new Array(c.length).fill(null); if (c.length <= n) return o; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / n, al = l / n; o[n] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al)); for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1], u = d > 0 ? d : 0, dn = d < 0 ? -d : 0; ag = (ag * (n - 1) + u) / n; al = (al * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al)); } return o; }
function atr(c, n = 14) { const tr = new Array(c.length).fill(null), o = new Array(c.length).fill(null); for (let i = 0; i < c.length; i++) tr[i] = i === 0 ? c[i].h - c[i].l : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (c.length <= n) return o; let a = 0; for (let i = 1; i <= n; i++) a += tr[i]; a /= n; o[n] = a; for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; o[i] = a; } return o; }
function vwap(c) { const o = new Array(c.length).fill(null); let day = null, pv = 0, vol = 0; for (let i = 0; i < c.length; i++) { const d = new Date(c[i].t).getUTCDate(); if (d !== day) { day = d; pv = 0; vol = 0; } const tp = (c[i].h + c[i].l + c[i].c) / 3; pv += tp * c[i].v; vol += c[i].v; o[i] = vol ? pv / vol : c[i].c; } return o; }
function sma(v, n) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
const minU = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
function inWindow(t, p) {
  const wd = new Date(t).getUTCDay();
  if (p.weekend === false && (wd === 0 || wd === 6)) return false;
  const m = minU(t), o = [];
  if (p.sessions.asia) o.push(0); if (p.sessions.london) o.push(420); if (p.sessions.ny) o.push(780);
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
function sugRRof(sc) { return sc >= 3 ? 1.5 : null; } // target resta 1.2; 1.5 solo come suggerimento su segnali forti

function liveSignal(ctx, p) {
  const i = ctx.candles.length - 2; if (i < 60) return null;
  for (const dir of ["long", "short"]) {
    if (checksFor(ctx, i, dir, p)) {
      const c = ctx.candles[i], av = ctx.a[i]; if (!av) continue;
      const risk = av * p.atrMult, entry = c.c;
      const stop = dir === "long" ? entry - risk : entry + risk;
      const target = dir === "long" ? entry + risk * p.rr : entry - risk * p.rr;
      const sc = signalScore(ctx, i, dir);
      return { dir, entry, stop, target, rr: p.rr, sc, sug: sugRRof(sc), entryTime: c.t };
    }
  }
  return null;
}

// ---------- Telegram ----------
async function sendTelegram(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status + ": " + (await r.text()).slice(0, 200));
}
const fmt = (n, d = 1) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------- NEW: segue il segnale aperto (esito stop/target + avviso) ----------
function resolveOpen(candles, s, maxHold, tfMin) {
  for (let j = 0; j < candles.length; j++) {
    const k = candles[j];
    if (k.t <= s.entryTime) continue;
    if (s.dir === "long") {
      if (k.l <= s.stop) return { reason: "stop", exit: s.stop };
      if (k.h >= s.target) return { reason: "target", exit: s.target };
    } else {
      if (k.h >= s.stop) return { reason: "stop", exit: s.stop };
      if (k.l <= s.target) return { reason: "target", exit: s.target };
    }
    // timeout solo su candela CHIUSA
    if (j < candles.length - 1 && (k.t - s.entryTime) >= maxHold * tfMin * 60000) return { reason: "timeout", exit: k.c };
  }
  return null;
}
function healthCount(ctx, i, dir) {
  const { candles, e9, e21, e50, r, vw } = ctx, c = candles[i], up = dir === "long";
  const checks = [
    { label: up ? "EMA9 > EMA21" : "EMA9 < EMA21", ok: up ? e9[i] > e21[i] : e9[i] < e21[i] },
    { label: up ? "EMA21 > EMA50" : "EMA21 < EMA50", ok: up ? e21[i] > e50[i] : e21[i] < e50[i] },
    { label: up ? "Prezzo > VWAP" : "Prezzo < VWAP", ok: up ? c.c > vw[i] : c.c < vw[i] },
    { label: up ? "RSI > 50" : "RSI < 50", ok: up ? r[i] > 50 : r[i] < 50 },
  ];
  return { ok: checks.filter(x => x.ok).length, total: checks.length, checks };
}

// ---------- NEW: log trade, riepilogo settimanale, comandi /status /stats ----------
const FEE_PCT = 0.10; // commissioni+slippage andata/ritorno in %, usate per il risultato NETTO
function statsOf(list) {
  const n = list.length, tp = list.filter(x => x.reason === "target").length, sl = list.filter(x => x.reason === "stop").length;
  const gross = list.reduce((s, x) => s + x.R, 0), net = list.reduce((s, x) => s + x.Rnet, 0);
  return { n, tp, sl, to: n - tp - sl, gross, net, win: n ? tp / n : 0 };
}
function statsLine(s) {
  if (!s.n) return "nessun trade chiuso";
  return `${s.n} trade · ✅${s.tp} 🛑${s.sl}${s.to ? " ⌛" + s.to : ""} · win ${Math.round(s.win * 100)}%\n` +
    `Netto fee: <b>${s.net >= 0 ? "+" : ""}${s.net.toFixed(2)}R</b> (lordo ${s.gross >= 0 ? "+" : ""}${s.gross.toFixed(2)}R)`;
}
async function readLog(env) { return JSON.parse((await env.BTC_STATE.get("log_BTC_15")) || "[]"); }
async function weeklyText(env) {
  const log = await readLog(env);
  const wk = log.filter(x => x.closedAt >= Date.now() - 7 * 86400000);
  const all = statsOf(log);
  return `<b>📊 Riepilogo · BTC 15m (R:R 1.2)</b>\n\n<b>Ultimi 7 giorni</b>\n${statsLine(statsOf(wk))}\n\n` +
    `<b>Da inizio tracciamento</b>\n${statsLine(all)}\n` +
    `Media netta: ${all.n ? (all.net >= 0 ? "+" : "") + (all.net / all.n).toFixed(3) + "R/trade" : "—"}\n` +
    `Campione: ${all.n}/30 trade per il criterio go-live\n\n` +
    `<i>Prima di pensare a soldi veri serve una media netta positiva per 3-4 settimane di fila.</i>`;
}
async function maybeWeekly(env) {
  const now = new Date();
  if (now.getUTCDay() !== 0 || now.getUTCHours() < 12) return; // domenica dalle 12:00 UTC (20:00 Shanghai)
  const key = "weekly_BTC_15", tag = now.toISOString().slice(0, 10);
  if ((await env.BTC_STATE.get(key)) === tag) return;
  await env.BTC_STATE.put(key, tag);
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, await weeklyText(env));
}
async function tgSecret(env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("btclab:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function statusText(env) {
  const candles = await fetchCandles(SYM.BTC, 15);
  const ctx = enrich(candles), px = candles[candles.length - 1].c;
  const open = JSON.parse((await env.BTC_STATE.get("open_BTC_15")) || "null");
  let s = `<b>📍 Status · BTC/USD 15m</b>\nPrezzo: <b>${fmt(px, 1)}</b>\n\n`;
  if (open) {
    const risk = Math.abs(open.entry - open.stop), up = open.dir === "long";
    const Rnow = (up ? px - open.entry : open.entry - px) / risk;
    const h = healthCount(ctx, candles.length - 2, open.dir);
    const hrs = ((Date.now() - open.entryTime) / 3600000).toFixed(1);
    s += `<b>Segnali aperti: 1</b>\n${up ? "🟢 LONG" : "🔴 SHORT"} aperto da ${hrs}h\n` +
      `Entry ${fmt(open.entry, 1)} · Stop ${fmt(open.stop, 1)} · Target ${fmt(open.target, 1)}\n` +
      `Ora: <b>${Rnow >= 0 ? "+" : ""}${Rnow.toFixed(2)}R</b> · mancano $${fmt(Math.abs(open.target - px), 0)} al target, $${fmt(Math.abs(px - open.stop), 0)} allo stop\n` +
      `Condizioni trend: ${h.ok}/${h.total}${open.warned ? " (avviso già inviato)" : ""}\n\n`;
  } else {
    s += `<b>Segnali aperti: 0</b> — in attesa di un setup\n\n`;
  }
  const log = await readLog(env);
  s += `<b>Ultimi 7 giorni</b>\n${statsLine(statsOf(log.filter(x => x.closedAt >= Date.now() - 7 * 86400000)))}\n\n`;
  s += `<b>Totale</b>\n${statsLine(statsOf(log))}`;
  const last = log[log.length - 1];
  if (last) s += `\n\nUltimo chiuso: ${last.dir.toUpperCase()} → ${last.reason} (${last.Rnet >= 0 ? "+" : ""}${last.Rnet.toFixed(2)}R netto)`;
  return s;
}
async function handleTelegram(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await tgSecret(env))) return new Response("forbidden", { status: 403 });
  const upd = await request.json().catch(() => ({}));
  const m = upd.message || upd.edited_message;
  if (!m || !m.text || String(m.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok");
  const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
  let reply = null;
  try {
    if (cmd === "/status") reply = await statusText(env);
    else if (cmd === "/stats" || cmd === "/riepilogo") reply = await weeklyText(env);
    else if (cmd === "/start" || cmd === "/help") reply = "Comandi:\n/status — segnale aperto, prezzo, risultati\n/stats — riepilogo 7 giorni + totale";
  } catch (e) { reply = "Errore: " + e.message; }
  if (reply) await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, reply);
  return new Response("ok");
}
async function setupWebhook(request, env) {
  const hook = new URL(request.url).origin + "/tg";
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: hook, secret_token: await tgSecret(env), allowed_updates: ["message"] }),
  });
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: [{ command: "status", description: "Segnale aperto e risultati" }, { command: "stats", description: "Riepilogo 7 giorni + totale" }] }),
  });
  return new Response("setWebhook: " + (await r.text()), { status: 200 });
}


// ---------- main check (shared by cron + manual test) ----------
async function runCheck(env) {
  const symbolName = "BTC"; // locked to BTC per setup
  const tfMin = 15;         // locked to 15-minute candles
  const sym = SYM[symbolName] || SYM.BTC;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const candles = await fetchCandles(sym, tfMin);
  if (candles.length < 100) return { ok: false, msg: "Not enough candles" };

  const ctx = enrich(candles);

  // NEW: segue il segnale aperto (esito + avviso condizioni)
  const openKey = "open_" + symbolName + "_" + tfMin;
  let open = env.BTC_STATE ? JSON.parse((await env.BTC_STATE.get(openKey)) || "null") : null;
  if (open) {
    const res = resolveOpen(candles, open, P().maxHold, tfMin);
    if (res) {
      const risk = Math.abs(open.entry - open.stop);
      const R = res.reason === "stop" ? -1 : res.reason === "target" ? open.rr
              : (open.dir === "long" ? res.exit - open.entry : open.entry - res.exit) / risk;
      const Rnet = R - (open.entry * FEE_PCT / 100) / risk;
      const icon = res.reason === "target" ? "✅ TARGET PRESO" : res.reason === "stop" ? "🛑 STOP PRESO" : "⌛ TIMEOUT (chiuso a tempo)";
      const txt =
        `<b>${icon} · ${open.dir.toUpperCase()} ${symbolName}/USD</b>\n` +
        `Entry ${fmt(open.entry, 1)} → Uscita <b>${fmt(res.exit, 1)}</b>\n` +
        `Risultato: <b>${Rnet >= 0 ? "+" : ""}${Rnet.toFixed(2)}R netto fee</b> (lordo ${R >= 0 ? "+" : ""}${R.toFixed(2)}R)\n` +
        `Segnale del ${new Date(open.entryTime).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, txt);
      await env.BTC_STATE.delete(openKey);
      const tlog = await readLog(env);
      tlog.push({ dir: open.dir, entry: open.entry, exit: res.exit, reason: res.reason, R, Rnet, entryTime: open.entryTime, closedAt: Date.now() });
      await env.BTC_STATE.put("log_BTC_15", JSON.stringify(tlog.slice(-1000)));
      open = null;
    } else if (!open.warned) {
      const hi = candles.length - 2;
      if (candles[hi].t > open.entryTime) {
        const h = healthCount(ctx, hi, open.dir);
        if (h.ok <= 1) {
          const px = candles[candles.length - 1].c;
          const txt =
            `<b>⚠️ Condizioni indebolite · ${open.dir.toUpperCase()} ${symbolName}/USD</b>\n` +
            `Solo ${h.ok}/${h.total} condizioni di trend ancora valide:\n` +
            h.checks.map(x => (x.ok ? "✓ " : "✗ ") + x.label).join("\n") + `\n` +
            `Prezzo ora ${fmt(px, 1)} · Stop ${fmt(open.stop, 1)} · Target ${fmt(open.target, 1)}\n\n` +
            `<i>Solo informativo: il backtest assume di tenere fino a stop/target. Chiudere prima è una tua scelta, non testata.</i>`;
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, txt);
          open.warned = true;
          await env.BTC_STATE.put(openKey, JSON.stringify(open));
        }
      }
    }
  }
  if (env.BTC_STATE) { try { await maybeWeekly(env); } catch (e) { console.error("weekly:", e.message); } }
  const sig = liveSignal(ctx, P());
  const key = "last_" + symbolName + "_" + tfMin;
  const last = env.BTC_STATE ? await env.BTC_STATE.get(key) : null;

  if (!sig) return { ok: true, msg: `[${symbolName} ${tfMin}m] WAIT — no signal on last closed candle` };
  if (last && parseInt(last) === sig.entryTime) return { ok: true, msg: `[${symbolName} ${tfMin}m] Already notified this signal, skipping` };

  const stars = "★".repeat(sig.sc) + "☆".repeat(4 - sig.sc);
  const dirWord = sig.dir === "long" ? "🟢 LONG" : "🔴 SHORT";
  const msg =
    `<b>${dirWord} ${symbolName}/USD · ${tfMin}m</b>\n` +
    `Entry: <b>${fmt(sig.entry, 1)}</b>\n` +
    `Stop: ${fmt(sig.stop, 1)}\n` +
    `Target: ${fmt(sig.target, 1)}  (R:R 1:${sig.rr.toFixed(1)})\n` +
    `Forza segnale: ${stars} (${sig.sc}/4)\n` +
    (sig.sug ? `💡 Segnale forte: volendo puoi puntare a 1:${sig.sug.toFixed(1)} → target ${fmt(sig.dir === "long" ? sig.entry + Math.abs(sig.entry - sig.stop) * sig.sug : sig.entry - Math.abs(sig.entry - sig.stop) * sig.sug, 1)} (il bot segue sempre 1:${sig.rr.toFixed(1)})\n` : "") +
    `Candela: ${new Date(sig.entryTime).toISOString().slice(0, 16).replace("T", " ")} UTC\n\n` +
    `<i>Segnale di studio, non consiglio finanziario. Un solo trade alla volta, rispetta lo stop.</i>`;

  await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg);
  // NEW: salva il segnale per poter avvisare di stop / target
  if (env.BTC_STATE && !open) await env.BTC_STATE.put(openKey, JSON.stringify({ dir: sig.dir, entry: sig.entry, stop: sig.stop, target: sig.target, rr: sig.rr, entryTime: sig.entryTime, warned: false }));
  if (env.BTC_STATE) await env.BTC_STATE.put(key, String(sig.entryTime));
  return { ok: true, msg: `[${symbolName} ${tfMin}m] Notified: ${sig.dir} @ ${fmt(sig.entry, 1)}` };
}

export default {
  // fires every minute via the Cron Trigger configured in the dashboard
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env).then(r => console.log(r.msg)).catch(e => console.error("ERROR:", e.message)));
  },
  // visiting the Worker's URL in a browser runs one check immediately — handy to test
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/tg" && request.method === "POST") return handleTelegram(request, env);
    if (u.pathname === "/setup-webhook") return setupWebhook(request, env);
    try {
      const r = await runCheck(env);
      return new Response(r.msg, { status: 200 });
    } catch (e) {
      return new Response("ERROR: " + e.message, { status: 500 });
    }
  },
};
