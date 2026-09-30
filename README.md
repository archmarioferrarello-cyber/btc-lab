# BTC Session Lab

Strumento di studio per un setup intraday su **BTC/USD, candele 15 minuti**. Tutto gratuito: GitHub Pages + Cloudflare Workers + Telegram.

| File | Cosa fa | Dove gira |
|---|---|---|
| `worker-notify.js` | **Bot Telegram — il riferimento.** Segnali, esiti (target/stop/timeout), avviso condizioni, riepilogo settimanale, comandi `/status` `/stats` | Cloudflare Worker `btc-lab-alert`, cron ogni minuto |
| `index.html` | App web: grafico, checklist, backtest, robustezza, chat | GitHub Pages |
| `worker-autotrader.js` | Autotrader in modalità PAPER (saldo simulato) — **non attivo** | (opzionale) Cloudflare Worker |

## Regole (uguali nel bot e nell'app)

- Solo **BTC/USD 15m**, un trade alla volta.
- Ingresso entro **120 min** dall'apertura di Asia (00:00 UTC), Londra (07:00) o New York (13:00), weekend incluso.
- LONG se, sull'ultima candela chiusa: EMA9 > EMA21, EMA21 > EMA50, prezzo sopra VWAP, RSI 50–72, volume sopra la media, chiusura nella metà alta. SHORT speculare (RSI 28–50).
- Stop = **1.5 × ATR**. Target = **R:R 1.2** (sempre).
- Segnali forti (≥ 3★) mostrano un suggerimento opzionale a **1:1.5**; bot e backtest restano a 1.2.
- Chiusura a stop, target o dopo 96 candele (24h). Fee+slippage stimate 0.10% andata/ritorno.

L'app mostra "✓ Allineato al bot Telegram" quando le impostazioni coincidono con il bot; se sposti gli slider compare il pulsante **↺ Riallinea al bot Telegram**.

## Bot Telegram (Cloudflare `btc-lab-alert`)

Messaggi automatici:
- 🟢/🔴 nuovo segnale (entry, stop, target, forza ★)
- ✅ TARGET / 🛑 STOP / ⌛ TIMEOUT con risultato in R **netto fee**
- ⚠️ condizioni indebolite (una volta per trade, solo informativo: uscire prima è una strategia diversa e non testata)
- 📊 riepilogo ogni **domenica 12:00 UTC** (20:00 Shanghai)

Comandi: `/status` (segnale aperto, prezzo, distanze, risultati) · `/stats` (7 giorni + totale, progresso verso 30 trade).

Configurazione Cloudflare:
- Secret `TELEGRAM_BOT_TOKEN`, variabile `TELEGRAM_CHAT_ID`
- KV namespace legato come **`BTC_STATE`** (chiavi: `last_BTC_15`, `open_BTC_15`, `log_BTC_15`, `weekly_BTC_15`)
- Cron Trigger `* * * * *`
- Dopo un nuovo deploy non serve rifare nulla; il webhook dei comandi si reimposta aprendo una volta `https://<worker>.workers.dev/setup-webhook`

## Pubblicare l'app

Repository → `index.html` → modifica o carica la nuova versione → Commit. GitHub Pages si aggiorna in circa un minuto.

## Prima di usare soldi veri

I backtest fatti finora non hanno mostrato un vantaggio positivo stabile dopo le fee. Criteri minimi, tutti insieme:
1. almeno **30 trade chiusi** tracciati dal bot (`/stats` mostra il conteggio);
2. media **netta** per trade positiva;
3. il pannello Robustezza dell'app segna "Held up";
4. tutto questo per **3-4 settimane consecutive**.

Solo allora: exchange regolamentato con verifica d'identità, API key senza permesso di prelievo, taglia minima.

*Strumento di studio, non consulenza finanziaria.*
