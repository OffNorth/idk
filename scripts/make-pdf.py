#!/usr/bin/env python3
"""
Génère docs/strategies.pdf (en anglais) à partir du catalogue du bot (src/catalog.js : familles, statut actif, verdict, résultat).
Usage (nécessite Python, reportlab et les polices DejaVu) :
    node -e "console.log(JSON.stringify(require('./src/catalog').catalog(require('./src/config'))))" > /tmp/catalog.json  # npm run pdf
    python3 scripts/make-pdf.py /tmp/catalog.json
"""
import datetime, json, os, struct, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
import re
import reportlab.platypus as _pl
from reportlab.platypus import SimpleDocTemplate, Spacer, Table, TableStyle, Image, PageBreak, KeepTogether, CondPageBreak
from reportlab.platypus.flowables import HRFlowable

# Les commandes internes (« npm run … ») ne servent pas au lecteur : retirées des textes du PDF
_NPM = [(re.compile(r'\s*\(npm (?:run|test)[\w\s,.-]*\)'), ''), (re.compile(r'\(npm run [\w.-]+(?:, [\w.-]+)*, '), '('),
        (re.compile(r',?\s*npm run [\w.-]+'), '')]


def _clean(t):
    if isinstance(t, str):
        for r, sub_ in _NPM:
            t = r.sub(sub_, t)
    return t


class Paragraph(_pl.Paragraph):
    def __init__(self, text, style=None, *a, **k):
        super().__init__(_clean(text), style, *a, **k)


_pl.Paragraph = Paragraph  # aussi pour le guide (scripts/guide_pdf.py)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'docs', 'strategies.pdf')
pdfmetrics.registerFont(TTFont('DV', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DVB', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
addMapping('DV', 0, 0, 'DV'); addMapping('DV', 1, 0, 'DVB'); addMapping('DV', 0, 1, 'DV'); addMapping('DV', 1, 1, 'DVB')

# Palette unique : encre, gris, un seul accent (mauve, comme le site), filets clairs
ACC, MUT, SOFT_HEX = '#6e45c9', '#667085', '#f4f0fd'
INK, MUTED, ACCENT, LINE, SOFT, ZEBRA, HILITE = (colors.HexColor(c) for c in ('#1d2330', MUT, ACC, '#e6e8ee', SOFT_HEX, '#fafafc', '#f7f3fe'))
GOLD = ACCENT
title = ParagraphStyle('t', fontName='DVB', fontSize=24, leading=30, textColor=INK, spaceAfter=6)
sub = ParagraphStyle('s', fontName='DV', fontSize=10, leading=14.5, textColor=MUTED)
kicker = ParagraphStyle('k', fontName='DVB', fontSize=8.5, leading=11, textColor=ACCENT, spaceAfter=3)
parth = ParagraphStyle('p', fontName='DVB', fontSize=20, leading=25, textColor=INK, spaceAfter=2)
h2 = ParagraphStyle('h2', fontName='DVB', fontSize=13, leading=17, textColor=ACCENT, spaceBefore=12, spaceAfter=5)
body = ParagraphStyle('b', fontName='DV', fontSize=9.2, leading=13.4, textColor=INK, spaceAfter=3)
bullet = ParagraphStyle('bl', parent=body, leftIndent=11, bulletIndent=1, spaceAfter=3.5)
note = ParagraphStyle('n', parent=body, fontSize=8.3, leading=11.6, textColor=MUTED, spaceBefore=2)
cell = ParagraphStyle('c', fontName='DV', fontSize=7.9, leading=10.4, textColor=INK)
cellb = ParagraphStyle('cb', parent=cell, fontName='DVB')
head = ParagraphStyle('h', fontName='DVB', fontSize=7.4, leading=9.5, textColor=ACCENT)
kpi = ParagraphStyle('kpi', parent=body, fontSize=8, leading=11, alignment=0)


def tstyle(extra=()):
    """Style commun des tableaux : en-tête teinté, lignes alternées, filets fins, pas de traits verticaux."""
    return TableStyle([('BACKGROUND', (0, 0), (-1, 0), SOFT), ('LINEBELOW', (0, 0), (-1, 0), 0.8, ACCENT),
                       ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, ZEBRA]), ('LINEBELOW', (0, 1), (-1, -1), 0.35, LINE),
                       ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                       ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5)] + list(extra))


def part(n, name, intro=None, soft=False):
    """Début d'une partie : nouvelle page (ou suite de la page s'il reste la place, soft), numéro, titre, filet."""
    out = ([CondPageBreak(150 * mm), Spacer(1, 7 * mm)] if soft else [PageBreak()]) + [Paragraph(f'PART {n}', kicker), Paragraph(name, parth), HRFlowable(width='100%', thickness=0.6, color=LINE, spaceBefore=4, spaceAfter=8)]
    if intro:
        out.append(Paragraph(intro, sub))
    return out

# Statut : une pastille par famille de statut (vert actif, ambre à l'essai, gris disponible, rouge rejeté)
STATUS = {
    'OR+NAS': ('Active · Gold + Nasdaq', '#ecfdf3', '#067647'), 'OR': ('Active · Gold', '#ecfdf3', '#067647'), 'NAS': ('Active · Nasdaq', '#ecfdf3', '#067647'),
    'ESSAI': ('Active · on trial', '#fffaeb', '#b54708'), 'DISPO': ('Available', '#f2f4f7', '#475467'), 'REJ': ('Rejected', '#fef3f2', '#b42318'),
    'REF': ('Benchmark', '#f2f4f7', '#475467'),
}
TF = {'1d': '1 day', '6h': '6 h', '1h': '1 h', '5m': '5 min', '1m': '1 min'}
esc = lambda s: str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def status(s):
    a = s['active']
    if s['id'] == 'hold':
        return 'REF'
    a = [m for m in a if m not in ('eurusd', 'spx', 'silver', 'dow')]  # autres marchés signalés à part dans le libellé
    if s['active'] and not a:
        return 'ESSAI'
    if a:
        if s['verdict'] == 'essai':
            return 'ESSAI'
        return 'OR+NAS' if len(a) == 2 else 'OR' if a[0] == 'gold' else 'NAS'
    return 'REJ' if s['verdict'] == 'rejet' else 'DISPO'


def table_for(rows):
    data = [[Paragraph(x, head) for x in ('Strategy', 'Id', 'Candles', 'Status', 'Result')]]
    style = []
    for r, s in enumerate(rows, start=1):
        st = status(s)
        label, bg, fg = STATUS[st]
        if 'spx' in s['active']:
            label += ' + S&amp;P 500'
        if 'silver' in s['active']:
            label += ' + silver'
        if 'dow' in s['active']:
            label += ' + Dow'
        if 'eurusd' in s['active']:
            label += ' + EUR/USD (trial)' if st != 'ESSAI' else ' (EUR/USD)'
        on = st in ('OR+NAS', 'OR', 'NAS', 'ESSAI')
        data.append([Paragraph(esc(s['name']), cellb if on else cell), Paragraph(f'<font color="{MUT}">{esc(s["id"])}</font>', cell),
                     Paragraph(TF.get(s['tf'], s['tf']), cell), Paragraph(f'<font color="{fg}">{label}</font>', cellb), Paragraph(esc(s['note'] or '—'), cell)])
        style.append(('BACKGROUND', (3, r), (3, r), colors.HexColor(bg)))
    t = Table(data, colWidths=[46 * mm, 21 * mm, 18 * mm, 31 * mm, 62 * mm], repeatRows=1)
    t.setStyle(tstyle(style))
    return t


def png_size(path):
    with open(path, 'rb') as f:
        f.read(16)
        return struct.unpack('>II', f.read(8))


def footer(canvas, doc):
    canvas.saveState()
    w = A4[0]
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, w - 16 * mm, 13 * mm)
    canvas.setFont('DV', 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 9 * mm, 'Paper trading bot · simulation only, no real money · past results ≠ future results')
    canvas.drawRightString(w - 16 * mm, 9 * mm, str(doc.page))
    if doc.page > 1:  # en-tête discret
        canvas.setFillColor(ACCENT)
        canvas.setFont('DVB', 7.2)
        canvas.drawString(16 * mm, A4[1] - 11 * mm, 'BOT STRATEGIES')
        canvas.setFillColor(MUTED)
        canvas.setFont('DV', 7.2)
        canvas.drawRightString(w - 16 * mm, A4[1] - 11 * mm, DATE_TXT)
    canvas.restoreState()


cat = json.load(open(sys.argv[1], encoding='utf-8'))
strats = [s for s in cat if s['id'] != 'hold']
active = [s for s in strats if s['active']]
n_gold = sum('gold' in s['active'] for s in strats)
n_nas = sum('nas100' in s['active'] for s in strats)
n_eur = sum('eurusd' in s['active'] for s in strats)
n_spx = sum('spx' in s['active'] for s in strats)
n_sil = sum('silver' in s['active'] for s in strats)
n_dow = sum('dow' in s['active'] for s in strats)
n_dispo = sum(status(s) == 'DISPO' for s in strats)
n_rej = sum(status(s) == 'REJ' for s in strats)
months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
d = datetime.date.today()

n_rus = sum('russell' in s['active'] for s in strats)
n_stk = sum(any(m in s['active'] for m in ('tlt', 'googl', 'pltr', 'lly', 'ba')) for s in strats)
DATE_TXT = f'{months[d.month - 1]} {d.day}, {d.year}'
doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=18 * mm, bottomMargin=19 * mm,
                        title='Paper trading bot strategies', author='Paper trading bot')
W = A4[0] - 32 * mm
story = [Spacer(1, 16 * mm), Paragraph('PAPER TRADING BOT · FILE', kicker),
         Paragraph('Bot strategies, FTMO and Lucid,<br/>and a guide to trading by hand', title),
         Paragraph(f'Gold, Nasdaq 100, S&amp;P 500, Dow Jones, Russell 2000, silver, EUR/USD and five stocks · as of {DATE_TXT}', sub), Spacer(1, 9 * mm)]
kpis = [(len(strats), 'strategies coded<br/>and tested'), (len(active), 'active<br/>live'), (n_dispo, 'positive,<br/>not enabled'), (n_rej, 'rejected<br/>in testing')]
kt = Table([[Paragraph(f'<font name="DVB" size="24" color="{ACC}">{a}</font><br/><br/><font color="{MUT}">{b}</font>', kpi) for a, b in kpis]], colWidths=[W / 4] * 4)
kt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), SOFT), ('LINEAFTER', (0, 0), (-2, -1), 5, colors.white), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                        ('TOPPADDING', (0, 0), (-1, -1), 11), ('BOTTOMPADDING', (0, 0), (-1, -1), 11), ('LEFTPADDING', (0, 0), (-1, -1), 11)]))
story += [kt, Spacer(1, 4), Paragraph(f'Active per market: gold {n_gold} · Nasdaq {n_nas} · S&amp;P 500 {n_spx} · Dow Jones {n_dow} · Russell 2000 {n_rus} · '
                                      f'silver {n_sil} · EUR/USD {n_eur} · stocks {n_stk} (some on several markets).', ParagraphStyle('n2', parent=note, spaceBefore=6)), Spacer(1, 6 * mm)]
story.append(Paragraph('Key points', h2))
for line in [
    'Daily strategies (long-term trend, seasons) are the most solid; on 1-hour candles and below, almost everything loses because of fees and noise.',
    'The accounts are tuned on history then checked on years never seen: <b>FTMO</b> passes ≈ 53 to 76% of challenges in under a year, '
    '<b>Lucid</b> ≈ 50 to 78%; about one Lucid evaluation in four passes within 2 weeks.',
    'The plan: pass Lucid, collect Lucid payouts, use them to fund FTMO accounts (risk × 0.75 once funded, challenge bought again if the account is lost).',
    'The validator AI helps on FTMO (+3 to +7 points of pass rate) but not on Lucid, where it only gives its opinion. Order flow, ICT and '
    '5 other ideas (overnight, VIX panic, Tuesday, pairs, news) were tested: nothing improves the accounts.',
    'Everything is simulated: live paper trading, posted in the Telegram group and on the website, is used to confirm these results without risking money.',
]:
    story.append(Paragraph(line, bullet, bulletText='•'))
story.append(Paragraph('Contents', h2))
toc = [('1', 'Strategy catalog', 'each strategy, its status and its result'),
       ('2', 'FTMO and Lucid accounts', 'rules, risk settings, AI, Lucid → FTMO plan'),
       ('3', 'Research', 'well-known traders, new markets, sessions, order flow, ICT'),
       ('4', 'The bot day to day', 'execution, live tracking, real-time data, personal portfolio'),
       ('5', 'Guide: trading by hand', 'the exact rules and a real example per strategy'),
       ('6', 'Simulated histories', 'the curves of the active strategies')]
tt = Table([[Paragraph(f'<font name="DVB" color="{ACC}">{n}</font>', body), Paragraph(f'<b>{a}</b>', body), Paragraph(f'<font color="{MUT}">{b}</font>', body)] for n, a, b in toc],
           colWidths=[10 * mm, 60 * mm, W - 70 * mm])
tt.setStyle(TableStyle([('LINEBELOW', (0, 0), (-1, -1), 0.35, LINE), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
story.append(tt)

story += part(1, 'Strategy catalog')
story.append(Paragraph('How to read the results', h2))
story.append(Paragraph(
    'Daily strategies: returns <b>per year, gains reinvested</b>, $1,000 at the start. <b>Gold</b>: 2001 → 2026 (GC=F future), fees 0.05% per side. '
    '<b>Nasdaq</b>: 2010 → 2026 (^NDX), fees 0.01% per side + 6%/yr CFD financing. Each strategy is <b>selected</b> on a first period then '
    '<b>verified</b> on a period not used for selection. <b>Intraday</b>: real spot gold 2009–2026, Nasdaq / S&amp;P / Dow / Russell / silver '
    'over 2 years (Nov 2024 → Nov 2026), realistic fees.', body))
keys = ('OR', 'ESSAI', 'DISPO', 'REJ')
legend = Table([[Paragraph(f'<font color="{STATUS[k][2]}">{"Active" if k == "OR" else STATUS[k][0]}</font>', cellb) for k in keys]], colWidths=[30 * mm] * 4, hAlign='LEFT')
legend.setStyle(TableStyle([('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3), ('LINEAFTER', (0, 0), (-2, -1), 4, colors.white)] +
                           [('BACKGROUND', (i, 0), (i, 0), colors.HexColor(STATUS[k][1])) for i, k in enumerate(keys)]))
story += [Spacer(1, 3), legend, Spacer(1, 2), Paragraph('“Active” names the market(s) (gold, Nasdaq, S&amp;P 500…); “on trial”: active on a market being tested.', note)]
ref = next((s for s in cat if s['id'] == 'hold'), None)
if ref:
    story.append(Paragraph('Benchmark', h2))
    story.append(Paragraph(f'<b>Holding the market</b>: {esc(ref["note"])}. A strategy that does no better, or not with less risk, adds nothing.', body))

ORDER = ['First strategies', 'In-house', 'Classic technical', 'Multi-horizon trend', 'Gold-specific', 'Nasdaq-specific',
         'Nasdaq intraday', 'Scalp 2nd series', 'Scalp (1–5 min)']
rank = lambda f: next((i for i, k in enumerate(ORDER) if f.startswith(k)), len(ORDER))
families = sorted({s['family'] for s in strats}, key=rank)
for i, fam in enumerate(families, start=1):
    rows = [s for s in strats if s['family'] == fam]
    story += [CondPageBreak(45 * mm), Paragraph(f'{i}. {esc(fam)} <font color="{MUT}" size="10">· {len(rows)}</font>', h2), table_for(rows)]

# Comptes FTMO simulés (réglages lus dans src/config.js)
import subprocess
fc = json.loads(subprocess.run(['node', '-e', "const c=require('./src/config');console.log(JSON.stringify({aa:c.autoAdapt,as:c.adaptStrategies,g:c.ftmoStrategies,gr:c.ftmoRisk,ir:c.ftmoIntradayRisk,n:c.ftmoNasStrategies,nr:c.ftmoNasRisk,ds:c.ftmoDayStop,cb:c.ftmoCombined,cnr:c.ftmoComboNasRisk,prog:c.ftmoProgram,sz:c.ftmoSizing,ai:c.ftmoAi,lu:c.lucidEnabled,lc:c.lucidCapital,lir:c.lucidIntradayRisk,lis:c.lucidIntradayStrategies,lm:c.lucidRiskMul,lcons:c.lucidConsistency,fd:c.fillDelaySec,lem:c.lucidEvalIntradayMul,lds:c.lucidDailyStrategies}))"],
                               cwd=ROOT, capture_output=True, text=True, check=True).stdout)
ids = lambda l: ', '.join(x.split(':', 1)[-1] for x in l)
num = lambda v: f'{round(v, 3):g}'
MK = {'silver': 'silver', 'dow': 'Dow', 'spx': 'S&P 500', 'nas100': 'Nasdaq', 'russell': 'Russell 2000'}
story += part(2, 'FTMO and Lucid accounts')
story.append(Paragraph('Simulated FTMO and Lucid accounts', h2))
story.append(Paragraph(
    ('<b>Simulated program: 1-step challenge</b> (launched by FTMO in February 2026; rules from secondary sources, to be checked): '
     '<b>+10%</b> in a single step, at least 4 trading days; fail if the daily loss reaches <b>3%</b> or if the account loses '
     '<b>10% from its high</b> (trailing max loss); the best day must not exceed half of the gain. '
     if fc['prog'] == '1step' else
     'FTMO 2-step challenge (2026 rules) on $100,000: <b>+10%</b> then <b>+5%</b>, at least 4 trading days per step; fail if the daily loss '
     'reaches 5% (open positions included) or the total loss 10%. ') +
    'Size of each trade = risk ÷ distance to the stop, max leverage 1:30, '
    f'no new trade for the day after −{fc["ds"]:g} %. Pass rate measured by starting a challenge every week of history.', body))
story.append(Spacer(1, 5))
ft = [[Paragraph(x, head) for x in ('Account', 'Strategies followed', 'Risk / trade', 'Pass rate')],
      [Paragraph('<b>Gold</b> (5 and 15 min scalps)', cell), Paragraph(esc(ids(fc['g'])), cell), Paragraph(f'{fc["gr"]:g}%', cell),
       Paragraph('≈ 80% in under 6 months over 2020–2026, 59% over the recent period (PAXG 5 min)', cell)],
      [Paragraph('<b>Nasdaq</b> (daily)', cell), Paragraph(esc(ids(fc['n'])), cell), Paragraph(f'{fc["nr"]:g}%', cell),
       Paragraph('in under a year: 42% (1985–1999), 43% (2000–2009), <b>39% (2010–2026, verification)</b>; old portfolio 21%', cell)]]
if fc['cb']:
    # Compte unique or + Nasdaq (npm run ftmo-combo)
    ft = [ft[0], [Paragraph('<b>Single Gold + Nasdaq account</b> (the bot’s)', cell), Paragraph(esc(ids(fc['g'])) + ' · ' + esc(ids(fc['n'])), cell),
                  Paragraph(f'{fc["gr"]:g}% (daily) · {fc["ir"]:g}% (intraday)', cell),
                  Paragraph(('Real gold (HistData 2009–2026), Nasdaq, S&amp;P 500, EUR/USD; ≈ 2.8 intraday positions per day (Asian and '
                             'New York sessions on gold, Crabel NR7 on the S&amp;P 500). Pass rate in under a year with the current settings (normal size, '
                             'halved with 2 open positions, trailing stop, “Lucid-like” evaluation): <b>53%</b> (2009–2019), <b>58%</b> (2020–2026), '
                             '<b>76%</b> (Nov 2024 → Nov 2026, intraday included), in ≈ 51 days median over the recent period; odds of the current challenge: /timemachine.')
                            if fc['prog'] == '1step' else
                            ('Sep 2020 → Oct 2024: <b>97% in under 6 months</b> (46 days median); last 2 years (verification): <b>46%</b> (34 days). '
                             'Gold scalps earn less since 2024.'), cell)]]
t = Table(ft, colWidths=[30 * mm, 62 * mm, 20 * mm, 66 * mm], repeatRows=1)
t.setStyle(tstyle())
story += [t, Spacer(1, 5)] + ([] if fc['cb'] else [Paragraph(
    'Nasdaq: daily strategies trade too rarely to make +10% in a year at low risk (0% pass at 0.5 or 1%); at 3%, about '
    '6 challenges in 10 still fail, mostly on the daily loss when several positions lose together. Selected on 1985–2009, verified on 2010–2026.', body)])
story += [Spacer(1, 4), Paragraph(
    '<b>Leverage and decreasing risk.</b> Each trade risks a fixed share of the account (size = risk ÷ distance to the stop, leverage capped at 1:30), '
    'halved as soon as 2 positions are already open. '
    + ('In addition, <b>risk decreases when nearing the target</b>: × (1 − 0.75 × progress toward +10%), at least × 0.4 '
       '(× 0.625 at +5%, × 0.4 from +8%), to protect the gain against the 3% daily loss. '
       if str(fc['sz']).startswith('objectif') else ''), body)]

def small_table(rows, widths):
    widths = [w * W / sum(widths) for w in widths]  # toujours la largeur de la page
    t = Table([[Paragraph(x, head) for x in rows[0]]] + [[Paragraph(x, cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
    # Ligne du réglage actuel (texte en gras ou « current ») : surlignée
    hl = [('BACKGROUND', (0, r), (-1, r), HILITE) for r, row in enumerate(rows[1:], start=1) if row[0].startswith('<b>') or 'current' in row[0].lower()]
    t.setStyle(tstyle(hl))
    return t

story += [Spacer(1, 3), small_table([
    ('1-step challenge, pass in under a year', '2009–2019', '2020–2026', 'Nov 2024 → Nov 2026'),
    ('Fixed risk (before)', '26% (53 d)', '30% (48 d)', '40% (34 d)'),
    ('<b>Risk decreasing near the target</b>', '<b>37%</b> (94 d)', '<b>46%</b> (113 d)', '<b>44%</b> (47 d)'),
    ('Risk × 2 to go faster', '4%', '11%', '19%'),
    ('<b>Normal size, ÷ 2 with 2 positions (current, 23/11/2026)</b>', '58%', '54%', '71%'),
], [72 * mm, 34 * mm, 34 * mm, 40 * mm]), Spacer(1, 2), Paragraph(
    'Each row was measured on a different date (strategies and risks of the time); the last row with the current strategies, '
    'before the Asian and New York sessions were added. The reduction near the target was removed on request: challenges ≈ 1 month '
    'faster. It remains available (FTMO_SIZING=objectif : dégressif doux). ', body), Spacer(1, 2), Paragraph(
    'Aiming for “2% per day” is not realistic: the account earns +0.1 to +0.25% per session on average; a +2.7% day happens about 1 session in 6, '
    'but −2% days are almost as frequent. Doubling the risk makes almost every challenge fail on the daily loss.', body)]

story.append(Paragraph('Trade validator AI', h2))
story.append(Paragraph(
    'For each signal, a model (logistic regression trained on ≈ 20,000 past trades) estimates the chance that the trade wins, using '
    'what is known at entry: recent form of the strategy and the market, stop distance, hour, day, trend, momentum and volatility of the market, VIX. '
    '<b>FTMO</b>: signals below the threshold (≈ 20% of signals) are not taken; each block is posted in the group (“trade blocked by '
    'the AI”), then its result when the shadow trade ends (the AI was right or wrong). <b>Lucid</b>: the AI only gives its opinion.', body))
story += [Spacer(1, 3), small_table([
    ('Pass < 1 year · each year judged by a model trained on the years before', '2009–19', '2020–26', 'Nov 24–26'),
    ('FTMO without AI', '34%', '43%', '69%'),
    ('<b>FTMO, the AI refuses 20% of signals (current)</b>', '<b>37%</b>', '<b>48%</b>', '<b>76%</b>'),
    ('<b>Lucid without AI (current)</b>', '<b>46%</b>', '<b>61%</b>', '<b>53%</b> · ≤ 14 d: 25%'),
    ('Lucid, the AI refuses 20% of signals', '47%', '75%', '33% · ≤ 14 d: 11% ✘'),
], [88 * mm, 28 * mm, 28 * mm, 34 * mm]), Paragraph(
    'Simplified settings for this test: compare the rows with each other. On Lucid, the model cannot tell good trades apart (AUC 0.53, 0.5 = random). '
    'Tried without a reliable gain: tree model, expected gain in R, refusing 10 or 30%; sizing the risk by the score clearly lowers the pass rate.', note)]

lucid_block = [Paragraph('FTMO or Lucid Trading?', h2), Paragraph(
    'The same strategies replayed under each firm’s rules (2026 secondary sources, to be checked). <b>LucidFlex</b>: CME micro futures in '
    'whole contracts, +6% target, <b>no daily loss limit</b>, but a max loss of <b>$2,000 (50K) / $3,000 (100K)</b> below the highest closing '
    'balance, locked at capital + $100. Funded phase 12 months max: FTMO 80% of gains (fee refunded), Lucid 90%. Settings chosen on 2009–2019.', body)]
lucid_block += [Spacer(1, 3), small_table([
    ('Firm', 'Pass < 1 year: 2009–19 / 2020–26 / Nov 24–26', 'Average net gain per challenge (2020–26)'),
    ('<b>FTMO 1-step 100K</b> (bot settings)', '37% / <b>46%</b> / 44%', '<b>+$1,113</b>'),
    ('FTMO 2-step 100K', '44% / 33% / 27%', '+$1,016'),
    ('LucidFlex 50K', '13% / 11% / 21%', '−$67'),
    ('LucidFlex 100K', '11% / 9% / 17%', '−$171'),
], [60 * mm, 70 * mm, 50 * mm]), Spacer(1, 2), Paragraph(
    'FTMO wins: Lucid’s lack of a daily loss limit does not make up for a max loss 3 to 5 times tighter. '
    + (f'<b>Live</b>, a simulated <b>LucidFlex {fc["lc"] // 1000}K</b> account (/lucid), in whole contracts (MGC, MNQ, MES, SIL, MYM micros; euro in standard 6E), '
       f'{fc["lcons"]:g}% consistency rule (best day) during the evaluation. This table is the old comparison (same strategies as FTMO); '
       'since then, Lucid has its own settings, see “Strategies for Lucid”. ' if fc['lu'] else '')
    + 'Several identical challenges at the same time multiply gains and losses alike: the accounts take the same trades and pass '
      'or fail together.', body)]
story.append(KeepTogether(lucid_block))

if fc['aa']:
    story.append(KeepTogether([Paragraph('Automatic adaptation', h2), Paragraph(
        'Every Sunday, an <b>automatic review</b> (posted in the group): every signal judged by the AI, taken or refused, is stored '
        'then labeled with the result of its paper trade; from 150 signals, the AI is <b>carefully retrained</b> (it stays close to its original '
        'model while there is little data) and the new version <b>is only adopted if it judges</b> the most recent signals better. '
        'Safety: if its recent refusals earn more than the trades it keeps, it switches itself back to observe mode. '
        + ('Strategy weights adapt too (reduced, increased, suspended, candidates promoted). ' if fc['as'] else
           'Automatic adaptation of strategy weights exists but stays off: it did not help on history. '), body),
        Spacer(1, 3), small_table([
            ('Replayed week by week (starting AI: 2009–2014)', '2015–2019', '2020–2026'),
            ('Without AI', '37%', '46%'),
            ('Frozen AI', '39%', '50%'),
            ('<b>Learning AI</b> (on)', '<b>51%</b>', '47%'),
            ('Adapting strategies', '32% ✘', '47%'),
            ('Everything adaptive', '49%', '47%'),
        ], [100 * mm, 40 * mm, 40 * mm]), Spacer(1, 2), Paragraph('1-step challenge pass rate in under a year.', body)]))

story.append(KeepTogether([Paragraph('Risk settings (FTMO and Lucid)', h2), Paragraph(
    'Hundreds of combinations tested (strategies kept × intraday risk × daily risk), selected on 2009–2019 then verified. '
    'Intraday strategies mostly add variance: on FTMO they stay but very small. Lucid has its own settings (see the '
    'next section).', body), Spacer(1, 3), small_table([
    ('Account', 'Settings', '2009–2019', '2020–2026', 'Nov 24–26'),
    ('FTMO (before)', 'intraday 0.5% · daily 1.5%', '37%', '46%', '44%'),
    ('FTMO (20/11 settings)', 'intraday 0.15% · daily 2%, decreasing risk', '64%', '67%', '83%'),
    ('FTMO (24/11, + Asian / NY sessions)', f'intraday {fc["ir"]:g}% · daily {fc["gr"]:g}%, normal size', '56%', '47%', '69%'),
    ('FTMO (25/11)', 'same, risk × 1.25, + Crabel NR7 S&amp;P 500', '50%', '51%', '67% (55 d)'),
    ('FTMO (26/11)', '+ trailing stop (from +2 R, 1 R from the best price), + intraday stocks', '55% (80 d)', '57% (76 d)', '73% (76 d)'),
    ('<b>FTMO (current)</b>', '+ correlation-based sizing (×0.5 if the same market group is open, or from 3 positions): +8 / +4 / +2 points on the test bench', '—', '—', '—'),
    ('Lucid (before)', 'same as FTMO', '13%', '11%', '21%'),
    ('Lucid (24/11)', f'daily {fc["gr"] * fc["lm"]:g}% · Nasdaq intraday {fc["lir"]:g}%, 0.5 R target', '56%', '69%', '100% (≈ 70 d)'),
    ('Lucid (25/11 morning)', '+ breakouts, Crabel, Williams, silver, Dow (≈ 4.7 intraday trades / day)', '55%', '72%', '94% (34 d)'),
    ('Lucid (25/11 evening)', '+ Double 7 and RSI 2 S&amp;P 500, Dow with break-even — <i>with an M6E micro euro that Lucid does not offer</i>', '56% ✘', '76% ✘', '100% ✘'),
    ('<b>Lucid (current)</b>', 'euro in real 6E (EUR/USD IBS too big) + Russell 10-day low, Nasdaq and silver Double 7; intraday 0.45%', '<b>50%</b> (79 d)', '<b>62%</b> (142 d)', '<b>78%</b> (41 d)'),
], [32 * mm, 58 * mm, 30 * mm, 30 * mm, 30 * mm]), Spacer(1, 2), Paragraph(
    'Pass rate in under a year, without the validator AI (also active live). Event strategies tested and not kept: day before the Fed '
    '(Lucca & Moench 2015) and day before a holiday (Ariel 1990) — strong on 2009–2012 and 2020–2026 but losing on 2017–2019.', body)]))

story.append(KeepTogether([Paragraph('Strategies for Lucid: fewer losses in a row', h2), Paragraph(
    'Lucid’s max loss ($2,000 trailing at end of day) only allows ≈ 10 losing trades in a row; breakout strategies (20 to 40% '
    'winners, up to 49 losses in a row) make it fail even when they win on average. So Lucid takes <b>“0.5 R target” variants</b> '
    'of the Nasdaq intraday strategies (same entry, same stop, profit taken at 0.5 × the risk; 0.75 R for some breakouts), then strategies from well-known '
    'traders and two new markets (next sections). Current list: ' + esc(', '.join(x.split(':', 1)[-1] + ('' if x.startswith('nas100:') else ' (' + MK.get(x.split(':')[0], x.split(':')[0]) + ')') for x in fc['lis'])) + '. '
    'The FTMO account keeps the originals. No gold intraday on Lucid (1 gold micro contract is too big for the max loss).', body), Spacer(1, 3), small_table([
    ('Lucid, Nov 2024 → Nov 2026 (49 starts)', 'Winners', 'Worst streak', 'Max drawdown', 'Pass rate'),
    ('Originals + n_pdlbrk (before)', '40%', '16 losses', '72 R', '49%'),
    ('<b>0.5 R target (current)</b>', '<b>66%</b>', '<b>6 losses</b>', '<b>17 R</b>', '<b>100%</b>'),
    ('0.3 / 0.75 / 1 R target', '75 / 57 / 52%', '6 / 9 / 15', '23 / 21 / 24 R', '92 / 82 / 67%'),
], [62 * mm, 26 * mm, 28 * mm, 30 * mm, 34 * mm]), Spacer(1, 2), Paragraph(
    'Only 2 years of Nasdaq intraday data: these rates are flattering. Over older periods (without intraday), Lucid passes 55 to 72%; '
    'count on 60 to 70% instead. An evaluation passed in 2 days is mostly luck (best-day rule ≤ 40%).', body)]))

story.append(KeepTogether([Paragraph('Plan: Lucid, payouts, then an FTMO account that lasts', h2), Paragraph(
    'Pass the Lucid evaluation fast, collect Lucid payouts, use them to pay for an FTMO account set up to last (scaling up to $2M). '
    '<b>Lucid funded</b> (Lucid’s official funded rules: contract cap by profit 20 / 30 / 40 micros, max loss locked at capital + $100 from the first payout, '
    '5 payouts max): first payout within 60 days 85%, median 17 days, ≈ $2,050 over 12 months (Nov 24–26), ≈ $1,840 (2020–24, daily only); '
    'the account rarely lasts. <b>Risk × 2 (current, chosen on 27/11/2026)</b>: more payouts in total ($2,611 / $2,749) but the first payout comes less often within 60 days recently (85 → 67%). <b>Daily strategies only (current, 27/11/2026)</b>: $3,021 of payouts over 12 months (Nov 24–26), accounts lost 91 → 78%. <b>Risk × 3 until the first payout, then × 1 (current, 27/11/2026)</b>: $5,159 / $3,467, accounts lost 32% / 59%. '
    'The cushion-based risk is NOT used on Lucid: with the max loss locked right after a payout it cuts payouts to ≈ $1,300. <b>FTMO during the evaluation</b>: set up “like Lucid” (intraday × 2, '
    'day over at +$2,500 or after 1 loss). <b>FTMO funded</b>: all risk × 0.75 (chosen on 26/11/2026), plus partial exits (⅓ at +1 R, ⅓ at +2 R, the rest on the trailing stop).', body),
    Spacer(1, 3), small_table([
    ('FTMO 100K funded (a start every week 2009–2023)', 'Alive at 12 / 24 / 36 months', 'Trader income / month (3-year average)', 'At least 1 scaling step'),
    ('Risk × 1', '18 / 3 / 0%', '$657 (≈ $2,340 buying again)', '41%'),
    ('<b>Risk × 0.75 (current)</b>', '<b>27 / 10 / 6%</b>', '<b>$655 (≈ $1,800 buying again)</b>', '<b>42%</b>'),
    ('Risk × 0.5', '66 / 45 / 35%', '$713 (≈ $1,100 buying again)', '50%'),
    ('Risk × 0.25', '100 / 100 / 100%', '$486', '0%'),
    ], [62 * mm, 38 * mm, 42 * mm, 36 * mm]), Paragraph(
    'Official FTMO scaling (Nov 2026): +25% every 4 months if the period’s net gain reaches +10%, with at least 2 payouts; cap of $2M across all '
    'accounts; 90% of gains to the trader (1-step). At × 0.25 the account never makes +10% in 4 months: no scaling, but it lasts. “Buying again”: '
    'a new challenge after each loss (55% pass rate, ≈ 1.7 months per attempt, $600 per failed attempt); more risk earns more on average, '
    'but the account is lost in ≈ 10 months at × 0.75. Several identical accounts: income × N, lost together. '
    'Partial exits: on funded accounts only; during the evaluation they do not help.', note)]))

story += part(3, 'Research', 'What was tested to improve the accounts, kept or not. Each idea must hold over every period, fees included.')
story.append(KeepTogether([Paragraph('Strategies from well-known traders (Lucid)', h2), Paragraph(
    'Methods published by Toby Crabel (breakout after a narrow day, NR4 / NR7), Larry Williams (volatility breakout: open ± k × '
    'previous range) and Linda Raschke, tested on the Nasdaq (QQQ regular session, Nov 2024 → Nov 2026). Stable both years and added to '
    'Lucid with a close target: <b>n_crabel4_t05</b>, <b>n_crabel7_15_t075</b>, <b>n_wvb05_t075</b>, <b>n_wvb07_t05</b>, plus the breakouts '
    '<b>n_orb10l_t075</b>, <b>n_orb30l_t075</b>, <b>n_or60_t05</b>: ≈ 4.7 intraday trades per day instead of 0.9, evaluation in ≈ 5 weeks instead of ≈ 10 (Nov 24–26). '
    'On FTMO, these strategies lower the pass rate (67 → 57%): only <b>Crabel NR7 30 min on the S&amp;P 500</b> (s_crabel7_30, +0.10 / +0.14 R per '
    'trade) is added there, with no loss of pass rate. Fabio Valentini-style auction market trading (volume profile, scalp) gave nothing stable.', body)]))

story.append(KeepTogether([Paragraph('New markets: silver and Dow Jones (Lucid)', h2), Paragraph(
    'Oil, silver, Dow Jones, Russell 2000, EUR/USD and Bitcoin tested (5-min intraday Nov 2024 → Nov 2026, daily since 2009). '
    '<b>Every new market lowers FTMO</b>: nothing added on FTMO. On Lucid, silver (Williams 0.5, SIL micro) and the Dow Jones '
    '(morning momentum, MYM micro), during the New York session only, keep the same pass rate and speed up the evaluation.', body),
    Spacer(1, 3), small_table([
    ('Lucid, pass < 1 year', '2009–2019', '2020–2026', 'Nov 24–26'),
    ('Without new markets', '55% (85 d)', '72% (110 d)', '94% (37 d)'),
    ('<b>+ silver + Dow (current)</b>', '55%', '72%', '<b>94% (34 d)</b>'),
    ('+ silver + Dow + Bitcoin', '55%', '72%', '88% ✘'),
    ('+ oil', '—', '—', '76% ✘'),
    ], [62 * mm, 38 * mm, 38 * mm, 42 * mm])]))

story.append(KeepTogether([Paragraph('Other markets and stocks', h2), Paragraph(
    'DAX and Nikkei (1 h candles, 2 years), pound (GBP/USD), yen (USD/JPY), US bonds (TLT ETF) and 18 large stocks (Nvidia, Tesla, Apple, '
    'Microsoft, Amazon, Meta, Google, AMD, Netflix, Broadcom, Palantir, Coinbase, JPMorgan, Exxon, Eli Lilly, UnitedHealth, MicroStrategy, Boeing), '
    '5-min intraday Nov 2024 → Nov 2026 and daily since 2000. <b>DAX and Nikkei</b>: no stable strategy. <b>Pound and yen</b>: London open '
    'breakouts are stable (USD/JPY: +0.24 / +0.13 R per trade), but they lower the accounts. <b>Stocks on daily</b> '
    '(Apple, Microsoft, Google, Netflix, UnitedHealth… profitable over 2000–09, 2010–17 and 2018–26): they lose on the same days as the Nasdaq and '
    'all lower FTMO. Lucid does not trade stocks (CME futures only).', body), Spacer(1, 3), small_table([
    ('FTMO account, pass < 1 year', '2009–2019', '2020–2026', 'Nov 24–26'),
    ('Current', '50%', '51%', '67% (55 d)'),
    ('+ GBP/USD intraday', '—', '—', '65% ✘'),
    ('+ USD/JPY intraday (Lucid: 94 → 90%)', '—', '—', '57% (41 d) ✘'),
    ('+ stocks on daily (depending on the stock)', '40–55% ✘', '40–54% ✘', '49–67%'),
    ('<b>+ TLT, Google, Palantir, Eli Lilly, Boeing intraday (added)</b>', '—', '—', '<b>69% (50 d)</b>'),
    ], [72 * mm, 32 * mm, 32 * mm, 44 * mm]), Spacer(1, 2), Paragraph(
    'Only the last row lowers nothing, for a small gain (≈ 1 challenge in 50, measured over 2 years only): <b>added to the FTMO '
    'account on 26/11/2026</b> (user’s choice) — TLT: Crabel NR7 15 min · Google: Crabel NR7 30 min · Palantir: 15-min breakout, Crabel '
    'NR7 15 min, Williams 0.5 · Eli Lilly: 5-min downside breakout · Boeing: Crabel NR7 15 min; CFDs, 1:5 leverage, ≈ 1.5 more positions '
    'per day (to check: that these CFDs exist on the FTMO platform). '
    'Conclusion of both market studies: the accounts are already well tuned, adding positions mostly adds variance.', body)]))

story.append(KeepTogether([Paragraph('Asian and New York sessions', h2), Paragraph(
    '92 variants tested on real spot gold 2009–2026 and the Nasdaq (2 years): opening breakouts (Tokyo, Shanghai, COMEX, New York), '
    'London fix, London close, last hour, Asian night, opening gaps, previous-day high / low, pre-market, '
    'Nasdaq overnight (NQ=F future). Kept on the FTMO account: <b>g_asiabrk</b> (breakout of the Asian overnight range at the London open: '
    '+20 / +13 / +16% over 3 slices) and <b>g_nypdl</b> (previous-day high / low breakout on gold during New York: +17 / +23 / +2.8%, '
    '+0.13 R per trade). Rejected: g_asia (losing on real gold), n_pdlbrk (negative on the New York regular session only), all overnight '
    'Nasdaq strategies.', body)]))

story.append(KeepTogether([Paragraph('Lucid: break-even and S&amp;P 500 daily strategies', h2), Paragraph(
    'Rather than stacking new families, we improved what Lucid already trades: stop moved to the entry price '
    '(“break-even”) after +0.3 / +0.5 R, day filters (Monday, Friday, wide or narrow previous day, opening gap) and daily strategies on other '
    'CME micro futures, added one by one. Kept: <b>Dow with break-even</b> (n_mom10_t1be: 1 R target, stop to entry after +0.5 R) and '
    '<b>Lucid’s own daily strategies</b>: ' + esc(', '.join(f'{x.split(":")[1]} ({MK.get(x.split(":")[0], x.split(":")[0])})' for x in fc['lds'])) + '. The filters raise the recent '
    'pass rate but halve the trades (evaluation in 50 to 64 days instead of 34): not kept.', body), Spacer(1, 3), small_table([
    ('Lucid, pass < 1 year', '2009–2019', '2020–2026', 'Nov 24–26'),
    ('Before', '55% (85 d)', '72% (110 d)', '94% (34 d)'),
    ('+ Dow break-even + Double 7 / RSI 2 S&amp;P (with micro euro)', '56% (74 d)', '76% (85 d)', '100% (37 d)'),
    ('Without micro euro (real 6E contract)', '45% (87 d)', '46% (131 d)', '76% (44 d)'),
    ('<b>+ Russell 10-day low, Nasdaq / silver Double 7</b>', '<b>50% (79 d)</b>', '<b>62% (142 d)</b>', '<b>78% (41 d)</b>'),
    ], [72 * mm, 34 * mm, 34 * mm, 40 * mm]), Spacer(1, 2), Paragraph(
    '<b>Correction (26/11/2026)</b>: Lucid’s official product list has <b>no micro currencies</b> (no M6E, no M6B); the euro only trades '
    'as the standard 6E (€125,000, ≈ $137,000 per contract), too big for the $2,000 max loss. The EUR/USD IBS, a big contributor to Lucid in '
    'the earlier calculations, therefore never fills: the real pass rate was lower. It is replaced by three daily strategies on micros '
    'that Lucid offers (Russell M2K, Nasdaq MNQ, silver SIL).', body)]))

story.append(KeepTogether([Paragraph('Other markets for Lucid (CME contracts)', h2), Paragraph(
    'Lucid only offers 34 contracts from the Chicago and New York exchanges (CME, CBOT, NYMEX, COMEX): <b>no CAC 40, DAX or European '
    'index</b>, no micro currencies, no rates, no crypto. Tested (2-year intraday + daily since 2000, '
    'real contract size and Lucid fees): copper, platinum, natural gas, corn, soybeans, wheat, soybean oil and meal, cattle, hogs, and '
    'standard currency contracts (Australian dollar, pound, Canadian dollar, euro, yen, Swiss franc, New Zealand dollar). Nikkei: $280,000 '
    'per contract, too big.', body), Spacer(1, 3), small_table([
    ('Lucid, evaluation risk', '2009–2019', '2020–2026', 'Nov 24–26 (≤ 14 d)'),
    ('Current (before the euro correction)', '45%', '46%', '39% (20%)'),
    ('+ soybeans or platinum intraday', '45%', '46%', '43% (20%)'),
    ('+ standard currencies intraday (6A, 6B, 6E, 6J)', '45%', '46%', '29–37% ✘'),
    ('+ corn, natural gas intraday', '45%', '46%', '41–43% (16–19%) ✘'),
    ('+ copper, gas, soybean daily', '—', '—', 'contracts too big: never taken'),
    ], [72 * mm, 30 * mm, 30 * mm, 48 * mm]), Spacer(1, 2), Paragraph(
    'Standard contracts ($25,000 to $150,000) are too big for a $2,000 max loss: the gain stays marginal (soybeans, platinum: +4 points '
    'over 2 years only, nothing within 2 weeks); not added. What works on Lucid remains the micros (Nasdaq, S&amp;P, Dow, Russell, silver).', body)]))

story.append(KeepTogether([Paragraph('Goal: pass in 2 weeks', h2), Paragraph(
    'A start every business day (Nov 2024 → Nov 2026), by risk level. At normal risk, ≈ 1% of evaluations pass within 2 '
    'weeks, FTMO and Lucid alike: the edge per trade is small, it takes time. FTMO caps at 3–5% within ≤ 14 days even at risk × 4 (and 56% '
    f'failures): unchanged. <b>Lucid</b>: intraday risk × {num(fc["lem"])} <b>during the evaluation</b> ({num(fc["lir"] * fc["lem"])}% instead of {num(fc["lir"])}%), '
    f'back to {num(fc["lir"])}% once the account is funded.', body), Spacer(1, 3), small_table([
    ('Lucid, intraday risk', 'Passed ≤ 14 d', 'Passed ≤ 30 d', 'Failed ≤ 14 d', 'Evaluations / funded account'),
    ('0.45% (× 1)', '1%', '17%', '1%', '1.3'),
    ('0.9% (× 2)', '17%', '44%', '26%', '1.9'),
    ('1.35% (× 3)', '20%', '34%', '51%', '≈ 2.6'),
    ('2.25% (× 5)', '17%', '25%', '68%', '3.4'),
    ], [46 * mm, 30 * mm, 30 * mm, 32 * mm, 42 * mm]), Spacer(1, 2), Paragraph(
    'About one evaluation in five passes within 2 weeks, but one in two fails in the same time: count on 2 to 3 evaluations bought per '
    'funded account. Figures from only 2 years of intraday data.', body), Spacer(1, 4), Paragraph(
    '<b>Day management</b> (Lucid during the evaluation): stop trading for the day as soon as the day’s gain '
    'reaches <b>25% of the target ($750)</b> — the best-day rule (≤ 40%) no longer blocks the pass — or <b>after the 1st losing trade</b>. '
    'Tested without gain: daily loss limit −0.5 / −1.5 / −2%, stopping after 2 or 3 losses, 1 to 3 positions max (slower). New '
    'signals tested and rejected: 20-day trend filter, partial exit, “gap and go” (losing everywhere), end / start of month.', body),
    Spacer(1, 3), small_table([
    ('Lucid, intraday risk × 3', 'Passed ≤ 14 d', 'Passed ≤ 30 d', 'Failed ≤ 14 d', 'Evaluations / funded account'),
    ('Without day management', '20%', '34%', '51%', '2.6'),
    ('<b>Stop at +$750 or after 1 loss (current)</b>', '<b>25%</b>', '<b>42%</b>', '<b>47%</b>', '<b>2.2</b>'),
    ], [56 * mm, 28 * mm, 28 * mm, 30 * mm, 38 * mm])]))

story.append(KeepTogether([Paragraph('FTMO account trailing stop', h2), Paragraph(
    'Tested on every strategy of the FTMO account: break-even at +1 R, 1 R trailing after +1 / +1.5 / +2 R, 0.5 R '
    'trailing, 3 / 4 ATR Chandelier, on intraday, daily or everything. Kept: <b>once the trade has made +2 R, the stop trails 1 R from the '
    'best price</b> (candle closes), on all strategies; it never moves back. Tighter settings cut the big gains '
    'that make the challenge pass. Lucid is not affected.', body), Spacer(1, 3), small_table([
    ('FTMO, pass < 1 year', '2009–2019', '2020–2026', 'Nov 24–26'),
    ('No trailing stop', '50% (67 d)', '51% (76 d)', '67% (55 d)'),
    ('Break-even at +1 R', '55%', '64%', '59% ✘'),
    ('Chandelier 3 ATR', '54%', '64%', '39% ✘'),
    ('<b>From +2 R, stop at 1 R (current)</b>', '<b>55% (80 d)</b>', '<b>57% (76 d)</b>', '<b>73% (76 d)</b>'),
    ], [72 * mm, 34 * mm, 34 * mm, 40 * mm]), Spacer(1, 3), Paragraph(
    '<b>Lucid, 6th study</b> (with the current settings): gold intraday (MGC) is not stable over 2009–2026 in any '
    'version; oil, Dow, silver neutral or negative; Russell nothing. Added: end-of-day momentum on the S&amp;P with break-even (MES): '
    'Nov 24–26 51 → 53%.', body)]))

story.append(KeepTogether([Paragraph('Order flow (delta, absorption, divergences)', h2), Paragraph(
    'Free real order flow: volume of aggressive buyers and sellers on Binance, minute by minute, Bitcoin and Ethereum 2020 → 2026 '
    '(3.6 million candles each), plus an approximated delta on the Nasdaq and the S&amp;P (2 years). Before fees, delta carries a little '
    'information at 1 minute; after fees, everything loses, everywhere: 0.04% of fees is worth ≈ 0.4 R on a 1-minute candle. Nothing added.', body),
    Spacer(1, 3), small_table([
    ('Bitcoin 1 min, real delta (average R per trade)', 'Before fees', 'After 0.04% fees'),
    ('Absorption', '+0.09 R', '−0.49 R'),
    ('Cumulative delta divergence', '+0.04 R', '−0.76 R'),
    ('Exhaustion', '+0.05 R', '−0.88 R'),
    ('Control “price only”', '0.00 R', '−0.77 R'),
    ], [90 * mm, 44 * mm, 44 * mm])]))
story.append(KeepTogether([Paragraph('ICT (FVG, Silver Bullet, liquidity, SMT, order blocks)', h2), Paragraph(
    'ICT rules written precisely and tested with fees: Nasdaq and S&amp;P on 1 and 5 minutes (2 years), gold on 5 minutes (2009 → 2026). '
    'A single rule passes: a <b>5-minute FVG in the direction of the previous day</b> (≈ +0.1 R per trade on the Nasdaq and the S&amp;P, positive over '
    'the 3 periods), but it fails on 1 and 15 minutes and is ≈ 0 on gold over 17 years: to be confirmed on a longer history, not added.', body),
    Spacer(1, 3), small_table([
    ('Average R per trade, fees included', 'Nasdaq', 'S&amp;P 500', 'Gold 2009–26'),
    ('Silver Bullet 10:00 – 11:00', '−0.15', '−0.11', '−0.06'),
    ('Sweep of the previous-day high / low', '−0.22', '−0.24', '−0.17'),
    ('SMT (Nasdaq / S&amp;P divergence)', '−0.31', '−0.39', '—'),
    ('Order block', '−0.27', '−0.38', '−0.19'),
    ('5-min FVG in the previous day’s direction', '+0.11', '+0.09', '+0.01'),
    ('Control: random entries', '−0.17', '−0.27', '−0.14'),
    ], [86 * mm, 30 * mm, 30 * mm, 32 * mm])]))

story.append(KeepTogether([Paragraph('Five new ideas (26/11/2026)', h2), Paragraph(
    'Overnight drift (buy the index at the close, sell at the open), rebound after panic (Connors “VIX stretch”), Turnaround Tuesday, '
    'gold / silver and Nasdaq / S&amp;P pairs, news (fade the 1st move or follow it: inflation and jobs at 8:30, Fed at 14:00). '
    'On their own, fees included, three hold over 2000–09, 2010–19 and 2020–26; but <b>none improves the accounts’ pass rate</b>: nothing added.', body),
    Spacer(1, 3), small_table([
    ('Idea', 'Alone (average R per trade, 3 periods)', 'Effect on the accounts'),
    ('Nasdaq overnight drift (trend or after a drop)', '+0.03 to +0.07 R ✔', 'Lucid 46 → 26–31% (2009–19) ✘'),
    ('Rebound after panic (VIX), S&amp;P', '+0.07 to +0.14 R ✔', 'none (too rare)'),
    ('Turnaround Tuesday Nasdaq / S&amp;P', '+0.07 to +0.18 R ✔', 'none (too rare)'),
    ('Gold / silver, Nasdaq / S&amp;P pairs', 'unstable or losing ✘', '—'),
    ('News: fade or breakout (indices, gold)', 'changes sign by period ✘', '—'),
    ('Not trading around news', '—', 'FTMO 69 → 67%, Lucid 53 → 45% ✘'),
    ], [70 * mm, 56 * mm, 52 * mm]), Paragraph(
    'News days are detected in the data (8:30 or 14:00 candle at least 3 times bigger than usual): the historical '
    'calendar is not reliable. The accounts are already well tuned: adding strategies mostly adds noise.', note)]))
story.append(KeepTogether([Paragraph('Asian session, 2nd study', h2), Paragraph(
    'Strategies trading during the Asian night (spot gold 2009–2026, USD/JPY and AUD/USD 2 years). <b>Nothing is stable</b> over every '
    'period: the only useful Asian strategy remains g_asiabrk (breakout of the Asian range at the London open, already on FTMO).', body),
    Spacer(1, 3), small_table([
    ('Idea (average R per trade, fees included)', 'Result'),
    ('Buy gold overnight (23:00 → 05:00 UTC)', '+0.04 / −0.02 / +0.03 / +0.08 R: almost, not 2013–16 ✘'),
    ('Sell gold overnight', '−0.07 to −0.24 R everywhere ✘ (gold rises a little overnight)'),
    ('Back to the middle of the Asian range (gold, USD/JPY, AUD/USD)', '−0.03 to −0.31 R ✘'),
    ('Reversal in Asia of a big New York move (gold)', 'zero or unstable ✘'),
    ('USD/JPY “gotobi” effect (before the Tokyo fix)', '−0.07 / +0.03 / −0.05 R, no better than other days ✘'),
    ], [96 * mm, 82 * mm])]))
story.append(KeepTogether([Paragraph('New York session, remaining ideas', h2), Paragraph(
    'The New York session already carries almost all of the bot’s intraday (opening breakouts, Crabel, Williams, end-of-day momentum). '
    'What remained were reversal ideas and an afternoon breakout, tested on the Nasdaq, the S&amp;P (2 years) and gold (2009–2026): '
    '<b>everything loses</b>. Fading a big New York move loses everywhere: the session is made for momentum.', body),
    Spacer(1, 3), small_table([
    ('Idea (average R per trade, fees included)', 'Nasdaq', 'S&amp;P 500', 'Gold'),
    ('Against the opening move (9:30 → 10:00)', '−0.02 to −0.55', '−0.09 to −0.57', '−0.14 to −0.30'),
    ('Midday reversal', '−0.00 to −0.50', '+0.48 to −0.23 (unstable)', '−0.02 to −0.25'),
    ('Reversal at the London close (11:30)', '+0.27 to −0.37 (unstable)', '+0.23 to −0.52 (unstable)', '−0.03 to −0.16'),
    ('Midday range breakout', '−0.05 to −0.06', '−0.03 to −0.11', '−0.02 to −0.07'),
    ], [72 * mm, 34 * mm, 40 * mm, 32 * mm])]))

story.append(KeepTogether([Paragraph('Optimizing returns: 7 ideas (26/11/2026)', h2), Paragraph(
    'Seven ideas never tested before, same method as always (pass rate in under a year 2009–19 | 2020–26 | Nov 24–26, kept only if nothing drops). '
    'Baseline of this test bench: FTMO 34 / 43 / 67%, Lucid 46 / 61 / 53% (≤ 14 days: 25%). <b>One idea is kept</b>: on the FTMO account, '
    'size is halved only when a position <b>from the same market group</b> (US indices and stocks, metals, currencies) is already open, or from '
    '3 open positions — instead of “as soon as 2 positions are open, whatever they are”.', body), Spacer(1, 3), small_table([
    ('Idea', 'Result', 'Decision'),
    ('<b>Correlation-based sizing (FTMO)</b>', 'FTMO <b>42 / 47 / 69%</b> (+2 / +18 / +6 median days); Lucid worse (39 / 46 / 51%)', '<b>added to FTMO</b> (FTMO_GROUP_SIZING=1)'),
    ('Other futures prop firms (same strategies)', 'nearly the same pass rate everywhere (44–46 / 63–64 / 47–51%)', 'Lucid stays a good choice'),
    ('Adding to winners (2nd unit at +1 R, stop to entry), FTMO funded', '12-month payouts +5% ($15,002 → $15,707), as many accounts lost, evaluation −1 point', '✘ too small'),
    ('VIX term structure (VIX / VIX3M)', 'no variant better everywhere (stress on 11% of days)', '✘'),
    ('Risk by entry hour', 'winning hours change from one period to the next; FTMO 28 / 39 / 49%', '✘'),
    ('No stock intraday on earnings days', '53 trades out of 1,039 (−0.01 R vs +0.08 R); pass rate unchanged', '✘ no effect'),
    ('Gold: 1-min entry instead of 5-min (Binance, Dec 2025 → Oct 2026)', 'total of the 6 breakouts +34% → +24% (g_mom8 +12.5 → +0.1%)', '✘'),
    ], [58 * mm, 82 * mm, 38 * mm]), Spacer(1, 4), Paragraph(
    '<b>Cost per funded account</b> (50K evaluation, Lucid strategies, failed evaluations and monthly fees included; list / promo price):', body), Spacer(1, 2), small_table([
    ('Firm', '2009–2019', '2020–2026', 'Nov 24–26'),
    ('<b>LucidFlex 50K (current)</b>', '$313 / $161', '$216 / $111', '$279 / $144'),
    ('Tradeify Select 50K', '$379 / $228', '$262 / $157', '$339 / $203'),
    ('Topstep 50K (monthly + $149 activation)', '$429', '$512', '$247'),
    ('Apex 50K EOD (monthly)', '$891 / $187', '$1,179 / $247', '$359 / $75'),
    ('Take Profit Trader 50K (monthly)', '$922 / $553', '$1,221 / $732', '$345 / $207'),
    ], [72 * mm, 36 * mm, 36 * mm, 36 * mm]), Paragraph(
    'Monthly subscriptions cost 2 to 5 times more when evaluations last months. Apex is only worth it during its big sales. Rules and prices '
    'from third-party 2026 sources, promo prices are assumptions: check them before buying. Payout rules once funded differ too much to compare here.', note)]))

story.append(KeepTogether([Paragraph('Optimizing returns: 7 more ideas (26/11/2026)', h2), Paragraph(
    'Same method. Two ideas are kept: <b>two Lucid evaluations at once</b> (one takes only the intraday strategies, the other only the daily ones, '
    'so their losses no longer stack on the same day) and <b>cushion-based risk on the funded FTMO account</b> (risk × remaining cushion before the '
    'max loss, from × 1 down to × 0.25). Funded-Lucid figures use Lucid’s official funded rules.', body), Spacer(1, 3), small_table([
    ('Idea', 'Result', 'Decision'),
    ('<b>Two different Lucid evaluations</b> (intraday | daily)', 'at least one passes within a year 92% (vs 49%), 34 days median (vs 13), cost per funded account $198 (vs $279); within 30 days unchanged (46%)', '<b>added</b> (LUCID_SPLIT=1)'),
    ('<b>Cushion-based risk, funded FTMO</b>', 'payouts over 24 months $17,052 → $23,768, accounts lost 99% → 29%', '<b>added</b> (FUNDED_CUSHION=1)'),
    ('Cushion-based risk, funded Lucid', 'payouts 12 months ≈ $2,050 → $1,300 (max loss locked from the 1st payout)', '✘ off on Lucid'),
    ('LucidFlex 100K instead of 50K', 'harder evaluation (39% vs 53% Nov 24–26); payouts $3,134 vs $2,161 but cost per funded $593 vs $256: about the same net per evaluation bought (≈ $1,000)', '✘ no gain (100K price estimated)'),
    ('Abandoning a bad evaluation (below −$750 to −$1,500)', 'same pass rate, slightly more evaluations bought', '✘'),
    ('Longer targets once Lucid is funded', '1 R: payouts +2% but first payout within 60 days 89 → 82%; 1.5 R / 2 R / none: clearly worse', '✘'),
    ('Pullback limit entries after a breakout', 'first test biased (fill inside the breakout candle); fixed: FTMO 42 / 43 / 53%, Lucid Nov 24–26 53 → 35%', '✘'),
    ('Closing daily positions before weekends', 'FTMO 42 / 47 / 69 → 27 / 30 / 43%', '✘'),
    ], [58 * mm, 82 * mm, 38 * mm])]))

story.append(KeepTogether([Paragraph('Lucid: 6 improvement ideas tested (27/11/2026)', h2), Paragraph(
    'Tested with npm run lucid-improve, Lucid’s official funded rules, funded risk × 2. Payouts = 12 months after funding (Nov 24–26 / 2020–24). '
    'Two ideas worsen nothing and are kept: <b>the daily evaluation without day management</b> and <b>the funded account on daily strategies only</b>. '
    'The others are trade-offs left to the user.', body), Spacer(1, 3), small_table([
    ('Idea', 'Result', 'Decision'),
    ('<b>Funded account: daily strategies only</b>', 'payouts $2,253 → $3,021 (Nov 24–26), 2020–24 equal; accounts lost 91 → 78%', '<b>added</b> (LUCID_FUNDED_ DAILY_ONLY=1)'),
    ('<b>Daily evaluation without day management</b>', 'pass 46 → 49%, within 30 days 61 → 62%; stop after 2 losses 48%; risk × 1.5 / × 2 worse', '<b>added</b> (LUCID_DAILY_ DAY_MGMT=0)'),
    ('Intraday evaluation at × 2 instead of × 3', 'pass 47 → 61%, failed within 14 days 51 → 33%, but passed within 14 days 32 → 25%; × 4 worse', 'trade-off (LUCID_EVAL_ INTRADAY_MUL)'),
    ('Waiting for a margin before asking for a payout', 'margin ≥ $1,500: payouts $2,253 → $2,796 (2020–24 $2,888 → $2,900), first payout within 60 days 67 → 59%; max payout only $2,973', 'trade-off'),
    ('Three evaluations (Nasdaq intraday | other intraday | daily)', 'at least one passes within 30 days 45 → 51%, within a year 92 → 99%, median 63 → 28 days; funded accounts 1.37 → 1.64 per start, cost per funded $198 → $248', 'trade-off (faster, dearer)'),
    ('LucidPro instead of LucidFlex (same price assumed)', 'evaluation similar (two evaluations: 22 days median); funded payouts $5,333 / $2,856 vs $2,253 / $2,888, lost 74%', 'to check: price and rules'),
    ('LucidDaily', 'funded payouts $3,375 / $4,342 but account lost 100% of the time', '✘'),
    ('50% consistency option (paid add-on)', 'cost per funded $196 vs $198, median 27 vs 63 days, intraday passes within 14 days 32 → 35%', 'to check: option price'),
    ], [44 * mm, 86 * mm, 48 * mm]), Paragraph(
    'Lucid plan prices are not published to automated readers: LucidPro, LucidDaily and the option were compared at the same price ($136). '
    'Check them on the Lucid website before choosing.', note)]))

story.append(KeepTogether([Paragraph('Lucid: 8 more ideas tested (27/11/2026)', h2), Paragraph(
    'Tested with npm run lucid-ideas3, current settings (intraday evaluation, daily evaluation without day management, combined evaluation, '
    'funded account on daily strategies). Payouts = 12 months after funding (Nov 24–26 / 2020–24). One idea is kept: '
    '<b>funded risk × 3 until the first payout, then × 1</b>. Lucid locks the max loss at the first payout, so the account is pushed '
    'until then and protected after (sizes stay capped by the contract limit).', body), Spacer(1, 3), small_table([
    ('Idea', 'Result', 'Decision'),
    ('<b>Funded: × 3 until the 1st payout, then × 1</b>', 'payouts $3,021 → $5,159 / $2,888 → $3,467, accounts lost 78 → 32% / 59%, first payout within 60 days unchanged; × 3 then × 1.5: $6,178 / $3,524 but lost 31 / 70%', '<b>added</b> (LUCID_FUNDED_ RISK_MUL=3, _AFTER=1)'),
    ('Funded: day over at +$150 / +$300', '+$300: $4,090 recently but 2020–24 $2,888 → $2,651', '✘'),
    ('Evaluations: risk × cushion before the max loss', 'intraday (floor × 0.5): pass 47 → 61%, failed within 14 days 51 → 36%, but passed within 14 days 32 → 28%; daily and combined worse', 'trade-off (intraday)'),
    ('Evaluations: bigger day cap (900 to 1,200 $, or from the 40% rule)', 'nothing better than +$750; intraday 47 → 41–45%', '✘'),
    ('Evaluations: smaller risk near the target', 'daily 49 / 62 / 100% → 53 / 55 / 90% (best variant); mixed', '✘'),
    ('Pausing a strategy that slips (N losses, below its average)', 'intraday below its 10-trade average: pass 47 → 53%, failures within 14 days 51 → 39%, but within 14 days 32 → 28%; daily worse', 'trade-off (intraday)'),
    ('Risk by volatility (stop width vs its last 20 trades)', 'daily 2020–26 62 → 68% but intraday ≤ 14 days 32 → 28% and combined worse', '✘'),
    ('Waiting after a failed evaluation before buying the next', 'intraday cost per funded $263 → $281–313; daily and combined about equal', '✘'),
    ], [44 * mm, 86 * mm, 48 * mm]), Paragraph(
    '<b>Lucid forbids hedging between accounts</b> (a buy on one account and a sell on another, same market, same time). Since 27/11/2026 the bot '
    'skips a Lucid signal when another Lucid account holds the opposite side (LUCID_NO_CROSS_HEDGE=1). Cost, worst case (funded account always active): '
    'about 20% of the intraday trades are skipped, intraday evaluation pass 47 → 31%, combined Nov 24–26 53 → 37%; daily and funded unchanged. '
    '<b>Several 50K accounts</b> rather than one 150K: the 150K pays ≈ ×1.6–2 per funded account for ≈ ×2.5 the cost; Lucid allows 5 funded accounts '
    'per household and copy trading between your own accounts.', note)]))

story += part(4, 'The bot day to day')
story.append(KeepTogether([Paragraph('Execution, notifications and tools', h2), Paragraph(
    f'<b>“Real-life” execution</b>: the FTMO and Lucid accounts enter and exit (on signal) at the price {fc["fd"]:g} s after the signal; stops and '
    'targets stay at their level. A price older than the signal data is '
    'ignored: the account then keeps the signal price. <b>Notifications</b>: every buy / sell of the accounts is posted in the Telegram group, with a private copy '
    'if the group does not get it. <b>Time Machine</b> (/timemachine): odds of passing the current challenge from 1,000 simulated years. '
    '<b>Funded accounts</b>: simulated payouts (FTMO every 14 days, Lucid after 5 winning days). <b>/reset</b> (admin): accounts reset '
    '(new challenge at the starting capital), history, archived trades and stats kept. <b>Test loop</b>: '
    'the whole bot replayed offline (commands, buttons, messages, full account cycle). <b>Language</b>: all Telegram messages, buttons and '
    'images are in English since 26/11/2026 (English commands /chart, /history, /fund, /game, /leaderboard next to the French ones).', body)]))

story.append(KeepTogether([Paragraph('Live tracking', h2), Paragraph(
    '<b>“Bot”</b> tab of the website marches-eight.vercel.app, in terminal style: FTMO, Lucid and personal portfolio accounts (balance, target, '
    'limits), markets followed, positions and trade history in green / red. <b>“Bot trades”</b> chart in TradingView style, '
    'candles from 1 minute to 1 day, automatic zoom on the position: each trade is drawn like TradingView’s position tool '
    '(red zone = risk to the stop, green zone = target, dotted line to the exit). <b>TradingView</b> button: the real '
    'TradingView chart (after consent for its trackers). <b>Pine</b> button: a script to paste into TradingView to see the bot’s trades on your '
    'own chart. <b>Telegram</b>: every trade, every trade blocked by the AI and its result, /pnl (daily PnL), /ftmo, /lucid, '
    '/myportfolio, /interface, /export. Updated about every 15 s.', body)]))
story.append(KeepTogether([Paragraph('Lucid: separate funded account, and backup candles', h2), Paragraph(
    '<b>Separate funded Lucid account</b>: when a Lucid evaluation passes, the funded account runs separately (“Lucid funded” in the messages, '
    'on the website and in /pnl, simulated payouts) and a new evaluation starts the next day, alongside FTMO. One funded account at a time; '
    'when lost, it goes to sleep until the next passed evaluation (or /fund lucid). Started directly on 26/11/2026, without waiting for an evaluation. '
    '<b>Three Lucid evaluations</b> (27/11/2026): intraday only (/lucid), daily only (/lucid daily) and a <b>combined</b> one taking both on the same account '
    '(/lucid combined, LUCID_COMBINED=1, with the day management), to compare the merged version live; any of them that passes starts the funded account. '
    '<b>Backup candles</b>: when Yahoo stops sending intraday candles while the price keeps moving (Thanksgiving 2026: nothing since 04:55 UTC on '
    'gold and futures), the bot builds its own 1-minute candles from the price read at each pass, until the real ones return. Less precise '
    '(one price per minute); never used when candles come from Binance or OANDA (real time).', body)]))
story.append(KeepTogether([Paragraph('Gold and silver in real time, no account: Binance', h2), Paragraph(
    'Yahoo gives gold and silver about 10 minutes late, and OANDA and Capital.com both require an identity check. '
    'Since 26/11/2026, the bot takes the intraday candles (1, 5 and 15 min) of gold and silver from <b>Binance’s public perpetual contracts</b> '
    '(XAUUSDT, XAGUSDT): public data, <b>no account, no key, no personal data</b>, in real time. Indices stay on Yahoo '
    '(no equivalent contract).', body), Spacer(1, 3), small_table([
    ('Point', 'How the bot handles it'),
    ('Accuracy', 'XAUUSDT tracks spot gold within +$7.0 (standard deviation $0.64), 0.997 correlation of 5-min moves (November 2026)'),
    ('Gap with Yahoo', 'measured when switching source (median of common 5-min closes); open positions shifted by the same amount, last gap kept if Binance goes down'),
    ('Hours', 'Binance trades 24/7: weekend candles (Friday 17:00 → Sunday 18:00, New York) and the 17:00 pause removed; silver: New York session'),
    ('Execution', 'the “30 s after the signal” price is also taken from Binance, on the same scale as the signal'),
    ('Blocked country or host', '451 “restricted location” response: Yahoo right away, new attempt every 30 min'),
    ('Outage', 'pass skipped for 10 min, then Yahoo'),
    ('Website', 'bot chart: Binance candles read by the browser (“Binance XAUUSDT · real time” tag), trades shifted by the gap; 1 day and indices on Yahoo'),
    ], [38 * mm, 140 * mm]), Paragraph(
    'Check from the bot’s machine: <b>npm run binance-check</b> (reachable or not, gap with Yahoo). /verif shows the source of each market. '
    'BINANCE_FEED=0 to go back to Yahoo.', note)]))
story.append(KeepTogether([Paragraph('Personal portfolio, without a prop firm', h2), Paragraph(
    'For your own money, over the long run: real ETFs, dividends included, no leverage, 0.1% fees, monthly rebalancing, in euros, '
    'December 2004 → November 2026. Chosen: <b>50% world, 10% gold, 40% given to five daily bot strategies</b> (RSI 2 and Double 7 on '
    'the S&amp;P 500, golden cross on the Nasdaq 100, trend and season on gold), simulated live in the bot (/myportfolio, €10,000).', body),
    Spacer(1, 3), small_table([
    ('Portfolio (in euros)', 'Per year', 'Worst drawdown', 'Worst year', '€300/month since 2005'),
    ('World (60% S&amp;P 500 + 40% outside the US)', '9.8%', '−53%', '−36%', '€320,000'),
    ('S&amp;P 500', '11.5%', '−51%', '−34%', '€438,000'),
    ('Nasdaq 100', '15.3%', '−47%', '−39%', '€791,000'),
    ('<b>Core + bot: 50% world, 10% gold, 40% bot (current)</b>', '<b>10.2%</b>', '<b>−26%</b>', '<b>−14%</b>', '<b>€299,000</b>'),
    ('Bot alone (5 strategies)', '9.3%', '−16%', '−2%', '€252,000'),
    ], [72 * mm, 22 * mm, 26 * mm, 26 * mm, 32 * mm]), Paragraph(
    'Total paid in: €79,200. The Nasdaq had 20 exceptional years (hindsight bias). A 10% Bitcoin sleeve with a trend rule '
    '(above its 200-day average, otherwise cash) improved the return without increasing the worst drawdown, even starting from the 2021 top; '
    'not added. VIX rebound and Turnaround Tuesday as bot sleeves: 10.0 → 9.4–9.6%/yr (invested only 2 to 12% of the time): not added.', note)]))

# Guide « trader sans le bot » (exemples réels : node scripts/guide-examples.js > docs/guide-examples.json)
_gx = os.path.join(ROOT, 'docs', 'guide-examples.json')
if os.path.exists(_gx):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import guide_pdf
    story += guide_pdf.build({'W': W, 'title': title, 'h2': h2, 'body': body, 'cell': cell, 'cellb': cellb, 'head': head, 'INK': INK, 'LINE': LINE,
                              'part': part, 'tstyle': tstyle, 'SOFT': SOFT, 'ZEBRA': ZEBRA, 'note': note},
                             json.load(open(_gx, encoding='utf-8')), fc)

story += part(6, soft=True, name='Simulated histories', intro='Each strategy starts from $1,000, gains reinvested, fees included. Legend and annual return in each image; '
              'grey dotted line: holding the market.')
for img, cap in [('historique-or-2001.png', 'Gold, 2001 → 2026 (GC=F future)'), ('historique-nasdaq-2010.png', 'Nasdaq 100, 2010 → 2026 (6%/yr CFD financing included)')]:
    path = os.path.join(ROOT, 'docs', img)
    w, h = png_size(path)
    width = W - 8 * mm
    frame = Table([[Image(path, width=width, height=width * h / w)]], colWidths=[W])
    frame.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#0b0f14')), ('TOPPADDING', (0, 0), (-1, -1), 4 * mm),
                               ('BOTTOMPADDING', (0, 0), (-1, -1), 4 * mm), ('LEFTPADDING', (0, 0), (-1, -1), 4 * mm), ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm)]))
    story += [Spacer(1, 6), KeepTogether([Paragraph(cap, h2), frame])]

def flow(items):
    out = []
    for it in items:
        if isinstance(it, KeepTogether) and not any(isinstance(x, (Image, Table)) and getattr(x, '_cellvalues', None) and isinstance(x._cellvalues[0][0], Image) for x in it._content):
            out += [CondPageBreak(55 * mm)] + flow(it._content)
        else:
            out.append(it)
    return out


doc.build(flow(story), onFirstPage=footer, onLaterPages=footer)
print(f'PDF écrit : {OUT} ({len(strats)} stratégies, {len(active)} actives, {n_dispo} disponibles, {n_rej} rejetées)')
