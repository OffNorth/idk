# Versions

Version number: `package.json` (shown as v1.0, v1.1, …), bumped with `npm run bump` at each update
(`npm run bump major` for a big change). `/version` in Telegram, the startup log and the website show it.

## v1.0 — 27/11/2026
Starting point of the numbering. Includes everything up to this date, in particular:
- Lucid: three evaluations (intraday, daily, combined) and a separate funded account; funded risk × 3 until the first
  payout then × 1; no opposite positions between Lucid accounts; no Nasdaq daily strategies; gold g_nypdl (0.2%) on the
  evaluations; silver intraday Crabel NR7 15 min; Russell RSI 2 on the funded account.
- Faster New York time computation (lower CPU); long Telegram messages split cleanly (/strategies).
