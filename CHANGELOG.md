# Versions

Version number: `package.json` (shown as v5.39, v5.40, …). Each update (commit) adds 1 to the minor number
(`npm run bump`); a big change starts a new major number (`npm run bump major`). `/version` in Telegram, the startup log
and the website show it, `/version` also gives the git commit.

The numbering was rebuilt from the whole git history (27/11/2026): one major number per big step, then one minor
number per commit since that step.

| Version | From | Big step |
|---|---|---|
| v1.0 → v1.7 | 11/09/2026 | meme-coin scanner (Telegram alerts) |
| v2.0 → v2.21 | 17/11/2026 | paper trading: gold, then Nasdaq 100 and other markets, strategies and backtests |
| v3.0 → v3.82 | 18/11/2026 | simulated FTMO account (/ftmo), FTMO-style strategies, research and challenge simulator |
| v4.0 → v4.111 | 20/11/2026 | simulated Lucid account (LucidFlex 50K, /lucid), funded accounts, website, PDF, videos |
| v5.0 → | 26/11/2026 | bot in English, Binance real-time gold / silver, Lucid optimizations |

## v5.44 — 28/11/2026
- FTMO: intraday signals only in the direction of the daily trend (close, EMA 50, EMA 200 aligned the day before;
  nothing when neutral) and day locked at +5% during the challenge (open positions closed). Research (ideas 16–17):
  pass within a year 42/47/69% → 51/53/84%. Not on Lucid (worse there).
- Tested and rejected: one position per idea, removing weak strategies, stronger daily strategies.

## v5.43 — 28/11/2026
- Daily backup of the bot's data (simulated accounts, trades, archives, AI learning, game) to the website's server,
  private (key derived from the bot token), the previous backup kept. If the server loses its data, the bot restores
  the last backup by itself at startup. /backup (admin) backs up now; npm run restore to restore by hand.

## v5.42 — 28/11/2026
- Sunday analysis: the bot publishes the Lucid strategies' paper trades and the AI scorecard to the website;
  scripts/weekly-stats.js + scripts/weekly-report.py build the weekly PDF (docs/weekly/, website “Week” button), written
  every Sunday by a scheduled Claude session.

## v5.41 — 28/11/2026
- AI learns from every paper signal (all strategies, followed or not), not only the FTMO account's: about 2–3× more examples
  (AI_LEARN_ALL=1). Lucid signals are stored too.
- Signal results labeled at every pass (not only on Sunday); live AI scorecard in /adapt and /export (accepted vs refused
  signals, win rate by AI probability).
- /export also holds the daily and combined Lucid evaluations and the archived trades of previous challenges.

## v5.40 — 27/11/2026
- /export open to everyone (the file holds no token, channel ID or server path).

## v5.39 — 27/11/2026
Readable version numbers rebuilt from the history. Since v5.0, in particular:
- Lucid: three evaluations (intraday, daily, combined) and a separate funded account; funded risk × 3 until the first
  payout then × 1; no opposite positions between Lucid accounts; no Nasdaq daily strategies; gold g_nypdl (0.2%) on the
  evaluations; silver intraday Crabel NR7 15 min; Russell RSI 2 on the funded account.
- Faster New York time computation (lower CPU); long Telegram messages split cleanly (/strategies).
