#!/usr/bin/env node
/**
 * Statistiques de la semaine (analyse du dimanche) à partir de l'état publié par le bot sur le site (/api/bot) :
 * comptes FTMO / Lucid (trades de la semaine, archives comprises), trades paper par stratégie, bilan de l'IA.
 * Usage : node scripts/weekly-stats.js [--days 7] [--file live.json] > stats.json
 */
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(opt('days', 7));
const URL = opt('url', 'https://marches-eight.vercel.app/api/bot');

const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 100) / 100;
const R = (t) => { const sl = t.sl0 ?? t.initSl ?? t.sl; const sp = Math.abs(t.entry - sl) / t.entry * 100; return sp > 0 && Number.isFinite(t.pnlPct) ? t.pnlPct / sp : 0; };
const group = (l, key, val) => {
  const m = {};
  for (const t of l) { const g = (m[key(t)] ??= { n: 0, wins: 0, total: 0 }); g.n++; if (val(t) > 0) g.wins++; g.total = r1(g.total + val(t)); }
  return m;
};

(async () => {
  const file = opt('file', null);
  const j = file ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : await (await fetch(URL)).json();
  const d = j.data || j;
  const to = Math.floor(Date.now() / 1000), from = to - DAYS * 86400;
  const accounts = {};
  for (const a of d.accounts || []) {
    const all = [...(a.archive || []), ...(a.closed || [])].filter((t) => t.exitT);
    const wk = all.filter((t) => t.exitT >= from);
    const wins = wk.filter((t) => t.pnl > 0), losses = wk.filter((t) => t.pnl <= 0);
    accounts[a.id] = {
      label: a.label, firm: a.firm, tag: a.tag, attempt: a.attempt, phase: a.phase, capital: a.capital, equity: Math.round(a.equity),
      gainPct: a.capital ? r1((a.equity / a.capital - 1) * 100) : null, target: a.target, open: (a.open || []).map((o) => ({ market: o.market, sid: o.sid, side: o.side })),
      history: (a.history || []).slice(-5), payouts: a.payouts || [],
      week: { trades: wk.length, wins: wins.length, pnl: Math.round(wk.reduce((s, t) => s + t.pnl, 0)),
        avgWin: wins.length ? Math.round(wins.reduce((s, t) => s + t.pnl, 0) / wins.length) : null,
        avgLoss: losses.length ? Math.round(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : null,
        byDay: group(wk, (t) => day(t.exitT), (t) => Math.round(t.pnl)), byStrategy: group(wk, (t) => `${t.market}:${t.sid}`, (t) => Math.round(t.pnl)),
        bySide: group(wk, (t) => t.side, (t) => Math.round(t.pnl)), byExit: group(wk, (t) => String(t.reason || '').replace(/ \(.*\)/, ''), (t) => Math.round(t.pnl)),
        best: [...wk].sort((x, y) => y.pnl - x.pnl).slice(0, 3).map((t) => ({ day: day(t.entryT), strategy: `${t.market}:${t.sid}`, side: t.side, pnl: Math.round(t.pnl) })),
        worst: [...wk].sort((x, y) => x.pnl - y.pnl).slice(0, 3).map((t) => ({ day: day(t.entryT), strategy: `${t.market}:${t.sid}`, side: t.side, pnl: Math.round(t.pnl) })) },
      sinceStart: { trades: all.length, wins: all.filter((t) => t.pnl > 0).length, pnl: Math.round(all.reduce((s, t) => s + t.pnl, 0)) },
    };
  }
  const paper = (d.paper || []).map((t) => ({ ...t, r: R(t) }));
  const pw = paper.filter((t) => t.exitT >= from);
  const out = {
    generatedAt: new Date().toISOString(), version: d.version, from: day(from), to: day(to), days: DAYS,
    accounts, aiScore: d.aiScore || null, ai: d.ai, adapt: d.adapt, diag: d.diag,
    paper: { week: { trades: pw.length, wins: pw.filter((t) => t.pnlPct > 0).length, totalR: r1(pw.reduce((s, t) => s + t.r, 0)),
      byStrategy: group(pw, (t) => `${t.market}:${t.sid}`, (t) => t.r), bySide: group(pw, (t) => t.side, (t) => t.r), byExit: group(pw, (t) => t.reason, (t) => t.r) },
    all: { trades: paper.length, byStrategy: group(paper, (t) => `${t.market}:${t.sid}`, (t) => t.r) } },
    markets: (d.markets || []).map((m) => ({ id: m.id, price: m.price, feed: m.feed })),
  };
  process.stdout.write(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });
