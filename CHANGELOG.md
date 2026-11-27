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

## v5.39 — 27/11/2026
Readable version numbers rebuilt from the history. Since v5.0, in particular:
- Lucid: three evaluations (intraday, daily, combined) and a separate funded account; funded risk × 3 until the first
  payout then × 1; no opposite positions between Lucid accounts; no Nasdaq daily strategies; gold g_nypdl (0.2%) on the
  evaluations; silver intraday Crabel NR7 15 min; Russell RSI 2 on the funded account.
- Faster New York time computation (lower CPU); long Telegram messages split cleanly (/strategies).
