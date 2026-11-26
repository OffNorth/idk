# Paper Trading Bot — Gold, Nasdaq 100 and more, with simulated FTMO and Lucid accounts

A Telegram bot that **paper trades** gold, the Nasdaq 100, the S&P 500, the Dow Jones, the Russell 2000, silver, EUR/USD
and a few stocks with many strategies in parallel, and runs **simulated prop-firm accounts** (FTMO 1-step challenge and
LucidFlex evaluations) that follow the strategies that held up in testing. Every trade, pass, fail and payout is posted
to a Telegram group and to a live web dashboard.

> ⚠️ **Simulation only.** No real order is ever sent and no trading account is connected. Not financial advice.
> Past results ≠ future results.

📄 The full strategy file — every strategy, the account rules, all research results and a guide to trading the strategies
by hand — is in **[docs/strategies.pdf](docs/strategies.pdf)** (34 pages, English). The detailed research log written
during development is kept in French in [docs/research-log-fr.md](docs/research-log-fr.md).

---

## What it does

```
Every minute (every CHECK_INTERVAL_MINUTES without scalp strategies)
  │
  ├─ Prices and candles for each active market
  │     gold & silver: Binance public perpetuals XAUUSDT / XAGUSDT (real time, no account) → Yahoo Finance if blocked
  │     indices, EUR/USD, stocks: Yahoo Finance (≈ 10 min delay on futures) · optional OANDA (OANDA_TOKEN)
  │     frozen Yahoo candles (US holidays): home-made 1-min backup candles
  ├─ Each strategy is evaluated at the close of each candle of ITS timeframe (1 min → 1 day)
  ├─ Paper trading: each strategy has its own simulated account
  ├─ Prop-firm accounts (FTMO, Lucid) copy the strategies they follow, with their own sizing and rules
  │     execution 30 s after the signal, validator AI, daily loss, trailing max loss, consistency rule, payouts
  │
  └─► Telegram group (every trade, AI blocks, pass / fail, payouts, daily summary) + live website + PnL videos
```

### Simulated accounts

| Account | Rules simulated | Strategies |
|---|---|---|
| **FTMO 100K, 1-step challenge** (`/ftmo`) | +10% target, 3% daily loss, 10% trailing max loss, best day ≤ 50% of the gain, min 4 days; funded: 80–90% split, payouts every 14 days | daily strategies (gold, S&P, EUR/USD) + gold / S&P / stock intraday breakouts |
| **LucidFlex 50K, two evaluations at once** (`/lucid`, `/lucid daily`) | +6% ($3,000), no daily loss limit, $2,000 end-of-day trailing max loss locked at capital + $100, best day ≤ 40%, whole CME micro contracts | one evaluation takes the **intraday** strategies (Nasdaq, Dow, silver), the other the **daily** ones (S&P, Nasdaq, Russell, silver) |
| **Separate funded Lucid account** | no consistency rule; payout after 5 winning days ≥ $150, ≤ 50% of the gain and ≤ $2,000; 90% split | everything Lucid trades |

Account management that came out of the research (all switchable in `.env`):
- **Correlation-based sizing (FTMO)**: size × 0.5 when a position from the same market group (US indices and stocks,
  metals, currencies) is already open, or from 3 open positions.
- **Cushion-based risk (funded accounts)**: risk × remaining cushion before the max loss (× 1 down to × 0.25).
- **Trailing stop (FTMO)**: once a trade has made +2 R, the stop trails 1 R from the best close.
- **Day management**: Lucid stops for the day at +$750 or after the first loss during the evaluation; FTMO the same way.
- **Validator AI**: a logistic model scores every signal; it blocks the weakest ≈ 20% on FTMO and only gives its opinion on
  Lucid. It retrains carefully every Sunday on live signals.
- **Funded FTMO**: risk × 0.75 and partial exits (⅓ at +1 R, ⅓ at +2 R).

The plan these accounts serve: pass Lucid fast, collect Lucid payouts, use them to pay for FTMO accounts set up to last.

---

## Key research results

Everything is tested the same way: strategies and settings are **chosen on one period and verified on another**, fees
included; an idea is only kept if no period gets worse. Pass rates below are "challenge passed within a year" over
2009–2019 | 2020–2026 | Nov 2024 → Nov 2026 (intraday data only exists for the last window).

| Topic | Result |
|---|---|
| Daily vs intraday | Daily trend / seasonal strategies are the most solid; on 1-hour candles and below, almost everything loses to fees and noise |
| FTMO account | ≈ 55 / 57 / 73% with the current settings, then +8 / +4 / +2 points from correlation-based sizing |
| Lucid account | ≈ 50 / 62 / 78%; running two different evaluations (intraday / daily) gets at least one pass within a year 92% of the time instead of 49%, at $198 instead of $279 per funded account |
| Funded accounts | cushion-based risk: FTMO payouts over 24 months $17,052 → $23,768, accounts lost 99% → 29%; Lucid accounts lost within 12 months 100% → 30% |
| Validator AI | helps FTMO (+3 to +7 points), not Lucid (opinion only) |
| Prop firms (same strategies) | Lucid, Tradeify, Topstep, Apex and Take Profit Trader pass about equally often; monthly subscriptions cost 2–5× more per funded account when evaluations last months |
| Rejected after testing | order flow, ICT, news trading, overnight drift, VIX term structure, risk by hour, longer targets once funded, pullback limit entries, closing before weekends, 1-min gold entries, abandoning bad evaluations, adding to winners, many extra markets |

Full tables: [docs/strategies.pdf](docs/strategies.pdf), part 3.

---

## Telegram commands

| Command | Role |
|---|---|
| `/menu [gold\|nasdaq]` | 🎛 Interactive panel (images that change with the buttons) |
| `/chart [gold\|nasdaq]` | 🕯 Candlestick chart |
| `/ftmo` · `/lucid` · `/lucid daily` | 🏦 🟣 Simulated FTMO and Lucid accounts |
| `/pnl [ftmo\|lucid] [days]` | 📅 Daily PnL of the simulated accounts |
| `/timemachine` | 🔮 Odds of passing the current challenge (1,000 simulated years) |
| `/history [gold\|nasdaq\|sp500\|eur\|ftmo]` | Trade history |
| `/simulation [gold\|nasdaq] [year]` | Strategy simulation over the price history |
| `/strategies` | How each active strategy works |
| `/myportfolio` | 💼 Simulated personal portfolio (50% world, 10% gold, 40% bot strategies) |
| `/interface` | 🖥 Live dashboard on the website |
| `/video` | 🎬 PnL video of a trade (send your own video to the bot in private) |
| `/game` · `/leaderboard` | 🎯 Daily prediction game |
| `/nasdaq` · `/gold` · `/sp500` · `/eurusd` | Text reports |
| `/version` · `/verif` | Version in service · consistency check of trades and data sources |
| `/fund [ftmo\|lucid]` · `/reset [ftmo\|lucid] ok` | (admin) force a funded account · reset accounts (stats kept) |
| `/export` · `/adapt` · `/bilan` · `/testcanal` · `/settings` · `/pause` · `/resume` · `/backtest` · `/pronostic` | (admin) tools |

French command names (`/graphique`, `/historique`, `/financer`, `/portefeuille`, `/jeu`, `/classement`) still work.

---

## Requirements

| Need | Why |
|---|---|
| An always-on host running **Node.js 20+** (e.g. Bot-Hosting) | check signals and stops every minute |
| A Telegram bot token (@BotFather) + a group or channel where the bot can post | post the trades |
| Internet access to Yahoo Finance and Binance (public data, no key) | prices and candles |
| ~150 MB of RAM, a few MB of disk | account and position state (`data/`) |
| Optional: ffmpeg (downloaded automatically) | PnL videos |

## Installation

```bash
git clone https://github.com/OffNorth/idk.git && cd idk
npm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, ALLOWED_TELEGRAM_USER_IDS
npm start
```

On startup the console shows the version, the Telegram connection and the first pass over the markets.
`npm run binance-check` tells you whether Binance's public gold / silver data is reachable from your machine.

On **Bot-Hosting**: a **Node.js** server, start file `bot.js`, create `.env` under *Files*, then *Restart*.

**Backup mode: GitHub Actions** — `.github/workflows/scanner.yml` runs one pass every 10 min on GitHub's servers, without
Telegram commands. Only enable it if the bot is not running elsewhere (otherwise trades are posted twice). Secrets:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`.

## Configuration

Every setting lives in `.env`; **[.env.example](.env.example)** lists them all with their defaults and an explanation.
The most useful ones:

| Variable | Default | Role |
|---|---|---|
| `FTMO_PROGRAM` | `1step` | FTMO program: `1step`, `2step` or `swing` |
| `FTMO_STRATEGIES` | see `.env.example` | strategies followed by the FTMO account (`market:id`) |
| `LUCID_SPLIT` | 1 | two Lucid evaluations (intraday / daily); 0 = a single one |
| `FTMO_GROUP_SIZING` / `FUNDED_CUSHION` | 1 / 1 | correlation-based sizing (FTMO) / cushion-based risk (funded accounts) |
| `FTMO_AI` / `LUCID_AI` | `block` / `observe` | validator AI mode |
| `BINANCE_FEED` | 1 | Binance real-time gold / silver candles (falls back to Yahoo) |
| `OANDA_TOKEN` | (empty) | optional real-time candles from an OANDA demo account |
| `FILL_DELAY_SEC` | 30 | execution delay after the signal on the prop-firm accounts |
| `PUBLISH_FTMO_ONLY` | 1 | the group only sees the prop-firm accounts |
| `LIVE_PUSH` / `SITE_URL` | 1 / marches-eight.vercel.app | live dashboard |

## Development

```bash
npm test            # unit tests (node:test)
npm run selftest    # the whole bot replayed offline: commands, buttons, messages, full account cycle
npm run pdf         # rebuild docs/strategies.pdf (Python + reportlab)
npm run check       # syntax check
```

Research scripts (`npm run <name>`) re-run any study from the PDF, for example `research`, `ftmo`, `lucid-research`,
`ai-research`, `sessions`, `ideas`, `optimize`, `optimize2`. Historical data is cached in `data/research/`.

## Project layout

```
bot.js                 Telegram bot + periodic pass
once.js                a single pass (GitHub Actions / cron)
selftest.js            offline replay of the whole bot
*-research.js, ftmo*.js research scripts (one per study)
src/cycle.js           one pass: markets → paper trading → prop-firm accounts → messages
src/markets.js         markets, data sources (Yahoo, Binance, OANDA), fees, financing
src/binance.js         Binance public perpetual candles (gold, silver)
src/staleFeed.js       backup candles when Yahoo freezes
src/gold.js            paper trading engine + backtest
src/strategies.js      strategy registry (+ gold2, nas2, goldmom, nasintra, sessions, meanrev, scalp2, ftmostrats, events)
src/strategies.en.json English names and descriptions of the strategies
src/ftmoAccount.js     simulated FTMO / Lucid accounts (rules, sizing, payouts, messages)
src/ftmo.js            challenge simulator used by the research and the Time Machine
src/sizing.js          sizing rules (correlation groups, cushion-based risk…)
src/aiFilter.js        validator AI · src/adapt.js weekly retraining
src/fill.js            execution 30 s after the signal
src/timeMachine.js     odds of the current challenge (Monte Carlo)
src/interactive.js     /menu panel and buttons · src/cards.js, src/draw.js, src/chart.js images
src/livePush.js        live state for the website · src/export.js statistics export
src/pnlVideo.js        PnL card videos · src/videoBot.js Telegram side
src/personalPortfolio.js simulated personal portfolio
src/catalog.js         strategy catalog (family, verdict, result) used by the PDF
scripts/make-pdf.py    builds docs/strategies.pdf (+ guide_pdf.py, guide-examples.js)
docs/                  strategies.pdf, charts, French research log
```

Code comments are mostly in French.
