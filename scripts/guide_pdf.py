"""
Guide « trader les stratégies sans le bot » du PDF (appelé par scripts/make-pdf.py) : bases (risque, taille, heures de
Paris), une fiche par famille de stratégies actives avec ses règles exactes et un exemple réel (dernier trade gagnant
sur les données Yahoo, docs/guide-examples.json, régénéré par `node scripts/guide-examples.js`), graphique en bougies.
"""
import datetime
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle, KeepTogether, PageBreak, CondPageBreak
from reportlab.graphics.shapes import Drawing, Rect, Line, String, Circle

UP, DOWN, ENTRY, STOP, TARGET, LEVEL = (colors.HexColor(c) for c in ('#16a34a', '#dc2626', '#2563eb', '#dc2626', '#16a34a', '#9ca3af'))


def fr(v, d=2):
    return f'{v:,.{d}f}'


def chart(ex, width=178 * mm, height=62 * mm):
    """Bougies du jour (ou des jours) de l'exemple, niveaux (gris pointillé), entrée (bleu), stop (rouge), objectif (vert)."""
    c = ex['candles']
    d = Drawing(width, height)
    if not c:
        return d
    pad_l, pad_r, pad_t, pad_b = 4, 60, 6, 14
    vals = [k['h'] for k in c] + [k['l'] for k in c] + [ex['entry'], ex['sl']] + ([ex['tp']] if ex.get('tp') else []) + [lv['v'] for lv in ex.get('levels', [])]
    hi, lo = max(vals), min(vals)
    span = (hi - lo) or 1
    hi += span * 0.04
    lo -= span * 0.04
    w = (width - pad_l - pad_r) / len(c)
    y = lambda v: pad_b + (v - lo) / (hi - lo) * (height - pad_t - pad_b)
    x = lambda i: pad_l + (i + 0.5) * w
    d.add(Rect(0, 0, width, height, fillColor=colors.HexColor('#fafafa'), strokeColor=colors.HexColor('#e5e7eb'), strokeWidth=0.5))

    labels = []  # étiquettes à droite, écartées si deux niveaux sont trop proches

    def hline(v, col, label, dash=None, wid=0.8):
        d.add(Line(pad_l, y(v), width - pad_r, y(v), strokeColor=col, strokeWidth=wid, strokeDashArray=dash))
        labels.append([y(v) - 2.5, label, col])

    for lv in ex.get('levels', []):
        hline(lv['v'], LEVEL, lv['label'][:28], dash=[2, 2], wid=0.6)
    for i, k in enumerate(c):
        col = UP if k['c'] >= k['o'] else DOWN
        d.add(Line(x(i), y(k['l']), x(i), y(k['h']), strokeColor=col, strokeWidth=0.5))
        top, bot = y(max(k['o'], k['c'])), y(min(k['o'], k['c']))
        d.add(Rect(x(i) - w * 0.35, bot, w * 0.7, max(0.4, top - bot), fillColor=col, strokeColor=col, strokeWidth=0.2))
    hline(ex['entry'], ENTRY, f'entry {fr(ex["entry"])}')
    hline(ex['sl'], STOP, f'stop {fr(ex["sl"])}')
    if ex.get('tp'):
        hline(ex['tp'], TARGET, f'target {fr(ex["tp"])}')
    labels.sort(key=lambda a: a[0])
    for k in range(1, len(labels)):
        labels[k][0] = max(labels[k][0], labels[k - 1][0] + 7)
    if labels:  # ne pas sortir du cadre en haut
        labels[-1][0] = min(labels[-1][0], height - 8)
        for k in range(len(labels) - 2, -1, -1):
            labels[k][0] = min(labels[k][0], labels[k + 1][0] - 7)
    for yy, label, col in labels:
        d.add(String(width - pad_r + 2, yy, label, fontName='DV', fontSize=6, fillColor=col))
    ei, xi = ex.get('entryIdx', -1), ex.get('exitIdx', -1)
    if 0 <= ei < len(c):
        d.add(Circle(x(ei), y(ex['entry']), 2.2, fillColor=ENTRY, strokeColor=colors.white, strokeWidth=0.5))
    if 0 <= xi < len(c):
        d.add(Circle(x(xi), y(ex['exit']), 2.2, fillColor=colors.HexColor('#111827'), strokeColor=colors.white, strokeWidth=0.5))
    # Heures (intraday) ou dates (journalier) en bas
    step = max(1, len(c) // 8)
    for i in range(0, len(c), step):
        lab = c[i].get('hm') or datetime.datetime.fromtimestamp(c[i]['t'], datetime.timezone.utc).strftime('%m/%d')
        d.add(String(x(i) - 6, 3, lab, fontName='DV', fontSize=5.5, fillColor=colors.HexColor('#6b7280')))
    return d


def build(S, ex, fc):
    """S : styles (title, h2, body, cell, cellb, head, INK, LINE) ; ex : exemples ; fc : réglages du bot."""
    body, h2, cell, cellb, head = S['body'], S['h2'], S['cell'], S['cellb'], S['head']
    h3 = ParagraphStyle('h3', parent=body, fontName='DVB', fontSize=10.5, leading=14, spaceBefore=6, spaceAfter=3, textColor=S['INK'])
    box = ParagraphStyle('box', parent=body, backColor=S.get('SOFT', colors.HexColor('#f3f4f6')), borderPadding=6, spaceBefore=5, spaceAfter=7)
    out = []

    def table(rows, widths):
        widths = [w * S['W'] / sum(widths) for w in widths] if 'W' in S else widths
        t = Table([[Paragraph(x, head) for x in rows[0]]] + [[Paragraph(x, cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
        t.setStyle(S['tstyle']([('VALIGN', (0, 0), (-1, -1), 'TOP')]) if 'tstyle' in S else TableStyle([('BACKGROUND', (0, 0), (-1, 0), S['INK']), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                               ('LINEBELOW', (0, 1), (-1, -1), 0.4, S['LINE']), ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
        return t

    def rules(rows):
        t = Table([[Paragraph(f'<b>{a}</b>', cell), Paragraph(b, cell)] for a, b in rows], colWidths=[30 * mm, S.get('W', 180 * mm) - 30 * mm])
        t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEBELOW', (0, 0), (-1, -1), 0.4, S['LINE']), ('BACKGROUND', (0, 0), (0, -1), S.get('ZEBRA', colors.HexColor('#f9fafb'))),
                               ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
        return t

    def example(key, unit, point_usd_lucid, contract, extra=''):
        e = ex.get(key) or {}
        if not e or e.get('error'):
            return [Paragraph('<i>Example unavailable (data).</i>', body)]
        sens = 'buy' if e['side'] == 'long' else 'sell'
        risk = abs(e['entry'] - e['sl'])
        when = f'{e["day"]}, entry at {e["entryTime"]} (Paris time), exit at {e["exitTime"]}' if e.get('day') else f'entry on {e["entryDay"]} at the close, exit on {e["exitDay"]}'
        why = {'take profit': 'target hit', 'stop loss': 'stop hit', 'exit signal': 'exit set by the rule', 'signal de sortie': 'exit set by the rule'}.get(e['reason'], e['reason'])
        daily = not e.get('day')
        lucid_risk = 50_000 * (fc['gr'] * fc['lm'] if daily else fc['lir'] * fc['lem']) / 100
        one = risk * point_usd_lucid
        n = int(lucid_risk // one) if one > 0 else 0
        if n < 1 and 0 < one <= min(1.5 * lucid_risk, 800):
            n = 1  # 1 contrat quand même si son risque reste raisonnable (règle du bot)
        size = (f'Size on Lucid 50K (risk {fr(fc["gr"] * fc["lm"]) if daily else fr(fc["lir"] * fc["lem"])}% = ${fr(lucid_risk, 0)}'
                f'{"" if daily else " during the evaluation"}): 1 {contract} risks '
                f'{fr(risk, 2)} × ${fr(point_usd_lucid, 0)} = ${fr(one, 0)} → {fr(lucid_risk, 0)} ÷ {fr(one, 0)} = <b>{n} contract(s)</b>'
                + (f', result {"+" if e["r"] >= 0 else "−"}${fr(abs(n * (e["exit"] - e["entry"]) * (1 if e["side"] == "long" else -1) * point_usd_lucid), 0)}' if n >= 1 else ' (too big: trade not taken)') + '.') if point_usd_lucid else ''
        txt = (f'<b>Real example</b> ({e["sym"]}): {when}. <b>{sens.capitalize()}</b> at {fr(e["entry"])}, stop {fr(e["sl"])} '
               f'(risk {fr(risk)} {unit} = 1 R)' + (f', target {fr(e["tp"])}' if e.get('tp') else '') + f'. Exit at {fr(e["exit"])} ({why}): '
               f'<b>{"+" if e["r"] >= 0 else ""}{fr(e["r"])} R</b>. {size} {extra}'
               f'<br/><font color="#6b7280">On recent data (since {e["since"]}): {e["n"]} trades, {fr(e["win"], 0)}% winners, '
               f'{"+" if e["avgR"] >= 0 else ""}{fr(e["avgR"])} R per trade on average — losses happen often, the edge is in the repetition.</font>')
        return [chart(e), Spacer(1, 2), Paragraph(txt, body)]

    # ---------------------------------------------------------------------------------------------------------------
    out += (S['part'](5, 'Guide: trading the strategies by hand') if 'part' in S else [PageBreak(), Paragraph('Guide: trading the strategies by hand', S['title'])]) + [Paragraph(
        'This guide explains, without jargon, how to reproduce yourself the strategies that work in the bot, with their exact rules and a '
        'real example taken from recent data. All times are <b>Paris time</b>. Golden rule: decide BEFORE entering where the stop is, where the '
        'target is and how much you risk — and never move the stop to “give the trade a chance”.', body)]

    out += [Paragraph('1. The basics', h2), Paragraph(
        '<b>The “R”</b>: the risk of a trade, the distance between your entry price and your stop. A trade that gains 2 times that distance '
        'makes +2 R; a stop hit makes −1 R. Counting in R lets you compare trades of different sizes.', body), Spacer(1, 3), Paragraph(
        '<b>Position size</b> is computed from the risk, never at random:<br/>'
        '<b>number of contracts = risk in $ ÷ (distance to the stop in points × value of one point)</b>, rounded down.<br/>'
        'If the result is 0: take 1 contract only if it risks at most 1.5 × the planned risk (and at most $800 at Lucid); '
        'otherwise the stop is too far for this account, <b>skip the trade</b>.', box), Paragraph(
        f'Risk per trade used by the bot: <b>Lucid</b> intraday {fr(fc["lir"] * fc["lem"])}% during the evaluation ({fr(fc["lir"])}% once funded), '
        f'daily {fr(fc["gr"] * fc["lm"])}%; <b>FTMO</b> intraday {fr(fc["ir"] * 1.25, 3)}%, daily ≈ {fr(fc["gr"] * 1.25)}%.', body), Spacer(1, 3),
        table([('Contract (Lucid)', 'Value of one point', 'Example: stop 100 points away'),
               ('MNQ (micro Nasdaq)', '$2 per point', '1 contract = $200 of risk'),
               ('MES (micro S&amp;P 500)', '$5 per point', '1 contract = $500'),
               ('MYM (micro Dow)', '$0.50 per point', '1 contract = $50'),
               ('MGC (micro gold)', '$10 per dollar of gold', '$10 stop → $100'),
               ('SIL (micro silver)', '$1,000 per dollar of silver', '$0.20 stop → $200'),
               ('FTMO XAUUSD (gold)', '1 lot = 100 ounces = $100 per dollar', '$10 stop → $1,000 per lot (0.1 lot = $100)')],
              [50 * mm, 55 * mm, 75 * mm]), Spacer(1, 3), Paragraph(
        '<b>Paris hours</b>: the New York session (Nasdaq, S&amp;P, Dow, silver) opens at <b>15:30</b> and closes at <b>22:00</b>. Careful: '
        'a few weeks a year (mid-March → end of March, end of October → early November), the US changes clocks before Europe: the '
        'session then opens at 14:30. “London” gold is read in UTC: 07:00 UTC = 08:00 in Paris in winter, 09:00 in summer.', body), Spacer(1, 3), Paragraph(
        '<b>Account rules</b>: Lucid 50K = +$3,000 (6%) to pass, max loss $2,000 below the highest end-of-day balance, and '
        'your best day must not exceed 40% of the total gain (so you need at least 3 winning days). FTMO 100K = +10%, daily loss 3%, '
        'max loss 10% from the high, best day ≤ 50% of the gain. <b>Trailing stop on FTMO</b>: once a trade has made +2 R, move '
        'the stop to 1 R below the best closing price (above it for a sell), and keep following it; never move it back.', body)]

    # ---------------------------------------------------------------------------------------------------------------
    out += [CondPageBreak(150 * mm), Paragraph('2. Opening breakout (Nasdaq)', h2), Paragraph(
        '<b>The idea</b>: the first minutes of the session set a range (the “opening range”). When price clearly leaves it, '
        'it often keeps going that way for a while. Enter on the break of the range, stop on the other side.', body), Spacer(1, 3), rules([
        ('Market', 'Nasdaq 100 (MNQ at Lucid, US100 / NAS100 at FTMO), New York session only.'),
        ('Preparation', '15:30 → 16:00: note the high and low of the first 30 minutes (30-min version). 5-minute candle chart.'),
        ('Entry', 'First 5-min candle that <b>closes above</b> the range high, before 18:00 → <b>buy</b> at the close of that candle. '
                  '(Lucid “upside” version: only upside breakouts are taken.)'),
        ('Stop', 'At the range low (the other side).'),
        ('Target', 'Lucid: 0.75 R (0.75 × the entry → stop distance). FTMO: no target, let it run.'),
        ('Exit', 'Target or stop hit; otherwise close at 21:55, before the close.'),
        ('Variants', '10-min range (same, 0.75 R target) · first hour 15:30 → 16:30 both ways (0.5 R target, entry before 21:00) · '
                     'FTMO: 15 min if the session opened above the previous close; sell below the low of the first 5 minutes.'),
    ])] + example('orb', 'points', 2, 'MNQ')

    out += [CondPageBreak(150 * mm), Paragraph('3. Crabel: the breakout after a quiet day', h2), Paragraph(
        '<b>The idea</b> (Toby Crabel): after a very narrow day, the market “releases” and often makes a big move. The opening breakout '
        'is taken ONLY on those days, which filters out many false starts.', body), Spacer(1, 3), rules([
        ('Market', 'Nasdaq 100 (Lucid), S&amp;P 500 (FTMO, NR7 30-min version).'),
        ('Day filter', '<b>NR4</b>: yesterday’s range (high − low) is the smallest of the last 4 sessions. '
                       '<b>NR7</b>: the smallest of the last 7. Otherwise: no trade today.'),
        ('Preparation', 'Range of the first 30 minutes (15:30 → 16:00); 15 minutes for the Lucid NR7 version.'),
        ('Entry', 'First 5-min close above the range → buy; below → sell (before 21:00).'),
        ('Stop', 'On the other side of the range.'),
        ('Target', 'Lucid: 0.5 R (NR4) or 0.75 R (NR7). FTMO: no target.'),
        ('Exit', 'Target, stop, or 21:55.'),
    ])] + example('crabel', 'points', 2, 'MNQ')

    out += [CondPageBreak(150 * mm), Paragraph('4. Williams: the volatility breakout', h2), Paragraph(
        '<b>The idea</b> (Larry Williams): if price moves away from the open by more than half of the previous day’s range, a real move '
        'is under way. The threshold adapts itself to current volatility.', body), Spacer(1, 3), rules([
        ('Market', 'Nasdaq 100 (MNQ) and silver (SIL, New York session) — Lucid.'),
        ('Preparation', 'Previous range = high − low of yesterday’s session (15:30 → 22:00). Thresholds: open ± 0.5 × range '
                        '(0.7 version: ± 0.7 × range).'),
        ('Entry', 'First 5-min close above “open + 0.5 × range” → buy; below “open − 0.5 × range” → sell.'),
        ('Stop', 'At the day’s opening price.'),
        ('Target', '0.75 R (0.5 version); 0.5 R (0.7 version).'),
        ('Exit', 'Target, stop, or 21:55.'),
    ])] + example('williams', 'points', 2, 'MNQ')

    out += [CondPageBreak(150 * mm), Paragraph('5. The morning move sets the end of the day', h2), Paragraph(
        '<b>The idea</b>: when the Nasdaq has already moved a lot early in the session, the last hour often goes the same way (big '
        'investors finish their orders).', body), Spacer(1, 3), rules([
        ('Market', 'Nasdaq 100 (MNQ); same rule on the Dow (MYM, Lucid).'),
        ('Condition', 'At 16:00 (10:00 in New York), price has moved more than 0.5% from the previous close, either way.'),
        ('Entry', 'At <b>21:00</b> (15:00 in New York), in the direction of the morning move.'),
        ('Stop', '3 ATR (3 × the average size of a 5-min candle over the last 14; TradingView’s “ATR 14” indicator).'),
        ('Target', 'Nasdaq Lucid: 0.5 R. Dow Lucid: 1 R, and as soon as the trade makes +0.5 R, <b>stop moved to the entry price</b> (it can no longer lose).'),
        ('Exit', 'Target, stop, or 21:55.'),
    ])] + example('mom', 'points', 2, 'MNQ')

    out += [CondPageBreak(150 * mm), Paragraph('6. Gold: London open breakout (FTMO)', h2), Paragraph(
        '<b>The idea</b>: London is gold’s main market. The range of London’s first half hour is the launch pad for the day.', body),
        Spacer(1, 3), rules([
        ('Market', 'Gold (XAUUSD at FTMO). Not on Lucid (1 gold micro contract is too big for its max loss).'),
        ('Preparation', 'Range from 07:00 to 07:30 <b>UTC</b> (08:00 → 08:30 in Paris in winter, 09:00 → 09:30 in summer). 60-min version: 07:00 → 08:00 UTC.'),
        ('Entry', 'First 5-min close above the range → buy; below → sell; before 09:30 UTC.'),
        ('Stop', 'On the other side of the range.'),
        ('Target', 'None: let it run until the evening (that is what makes the big gains, with only ≈ 25% winning trades).'),
        ('Exit', 'Stop, or 19:55 UTC (20:55 in Paris in winter).'),
    ])] + example('londres', '$', 0, 'MGC', 'FTMO size: risk ≈ 0.19% of $100,000 = $190; 1 XAUUSD lot = $100 per dollar.')

    out += [CondPageBreak(150 * mm), Paragraph('7. Gold: Asian overnight range breakout (FTMO)', h2), Paragraph(
        '<b>The idea</b>: during the night (Tokyo, Hong Kong, Shanghai) gold moves little. When Europe arrives, the break of this overnight range '
        'often sets the direction of the day.', body), Spacer(1, 3), rules([
        ('Market', 'Gold (XAUUSD, FTMO).'),
        ('Preparation', 'High and low from 00:00 to 07:00 UTC (01:00 → 08:00 in Paris in winter).'),
        ('Entry', 'First 5-min close above → buy, below → sell; before 11:00 UTC.'),
        ('Stop', 'On the other side of the overnight range.'),
        ('Exit', '19:00 UTC (or stop).'),
        ('Other gold strategies (FTMO)', '<b>Previous-day high / low</b>: between 08:20 and 12:00 New York, a close beyond it → follow, 1.5 ATR stop, '
         'exit 16:55 NY. <b>Opening gap</b>: gold opens at 07:00 UTC more than 0.3% from the previous day and keeps going after 15 min → follow, '
         '2 ATR stop. <b>Morning → afternoon</b>: at 08:00 UTC, gold has moved more than 0.25% since 20:00 UTC the day before → take that direction at 12:30 UTC, '
         '3 ATR stop, exit 19:55 UTC.'),
    ])] + example('asie', '$', 0, 'MGC', 'FTMO size: risk ≈ $190; $68 stop → 190 ÷ (68 × 100) ≈ 0.03 lot.')

    out += [CondPageBreak(150 * mm), Paragraph('8. Buying pullbacks on daily charts', h2), Paragraph(
        '<b>The idea</b>: in a market rising over the long run (above its 200-day average), a small drop of a few days is '
        'often bought back. Buy the dip at the close, sell on the rebound. These strategies win often (70–80% of trades) but a '
        'trade can last several days: held overnight.', body), Spacer(1, 3), rules([
        ('Common filter', 'Daily close <b>above the 200-day moving average</b> (“SMA 200” indicator on a daily chart). Otherwise nothing.'),
        ('RSI 2', 'Buy at the close when the 2-day RSI is below 10; sell at the first close above the 5-day average.'),
        ('Double 7', 'Buy when the market closes at its lowest of the last 7 days; sell when it closes at its 7-day high.'),
        ('3 down days', 'Buy after 3 lower closes in a row; sell at the first higher close.'),
        ('IBS', 'IBS = (close − low) ÷ (high − low). Buy if IBS &lt; 0.2; sell if IBS &gt; 0.8 or a close above the previous day’s high.'),
        ('Others', '<b>−5% below the 20-day high</b> → buy, sell back at that high · <b>10-day low</b> → buy, sell at the '
                   '5-day high · <b>−2.5% in one session</b> or <b>2 sessions at −1%</b> → buy, sell at a close above the previous day’s high.'),
        ('Stop', '3 daily ATR below the entry (rarely hit, it is a safety net).'),
        ('Where', 'Lucid: S&amp;P 500 (MES: RSI 2, Double 7, 3 down days), Nasdaq (MNQ: RSI 2, Double 7, 10-day low…), Russell 2000 (M2K: 10-day '
                  'low), silver (SIL: Double 7). FTMO: gold, S&amp;P, Nasdaq, EUR/USD (IBS — not on Lucid: no micro euro).'),
    ])] + example('repli', 'points', 5, 'MES') + [Spacer(1, 6)] + example('double7', 'points', 5, 'MES')

    out += [CondPageBreak(150 * mm), Paragraph('9. “Macro” filters (daily)', h2), Paragraph(
        '<b>The idea</b>: some markets react to others. You just look at another chart before buying.', body), Spacer(1, 3), rules([
        ('Falling dollar', 'Dollar index (DXY) −2% in 10 sessions and Nasdaq above its 50-day average → buy the Nasdaq; sell when the DXY gets back above its 10-day average.'),
        ('Falling gold', 'Gold −4% in 10 sessions and Nasdaq / S&amp;P above their 50-day average → buy; sell when gold gets back above its 10-day average.'),
        ('Falling rates', 'US 10-year yield (^TNX) −5% in 5 sessions and gold above its 50-day average → buy gold; sell when rates get back above their 10-day average.'),
        ('Low rates', '10-year yield below its 50-day average AND Nasdaq above its 50-day average → stay long; get out as soon as one condition fails (4 ATR stop).'),
        ('Averages', 'Gold: EMA 20 crossing above EMA 50 (RSI &lt; 70) → buy, 1.5 ATR stop, 3 ATR target. Bollinger: close below the lower band above the 200 average → buy, sell at the 20 average.'),
    ])]

    out += [Paragraph('10. The daily routine', h2), table([
        ('Time (Paris, winter)', 'To do'),
        ('01:00 → 08:00', 'Gold: the Asian night sets its range (nothing to do, look when you wake up).'),
        ('08:00 → 10:30', 'Gold: London range (08:00 → 08:30), London and Asian-range breakouts.'),
        ('15:30 → 16:30', 'Nasdaq / S&amp;P / Dow / silver: note the opening ranges (5, 10, 15, 30, 60 min), check whether yesterday was NR4 / NR7, compute the Williams thresholds.'),
        ('16:00', 'Note the move since yesterday’s close (21:00 momentum).'),
        ('21:00 → 21:55', 'End-of-day momentum; close everything at 21:55.'),
        ('22:00 (close)', 'Daily: RSI 2, Double 7, 3 down days, IBS… at the close; review the exits of open positions.'),
    ], [42 * mm, 138 * mm]), Spacer(1, 4), Paragraph(
        '<b>Discipline</b>: log every trade (date, rule, entry, stop, target, result in R); only take trades that follow '
        'the rule EXACTLY; on Lucid during the evaluation, <b>stop for the day at +$750 (25% of the target) or after the first losing '
        'trade</b> (that is what the bot does: more passes within 2 weeks, fewer failures); on FTMO, stop after −1% in the day. '
        'A strategy that earns +0.1 to +0.2 R per trade on average often loses several times in a row: that is normal, repetition is what pays. '
        'Past results guarantee nothing — start in simulation or on a demo account.', body)]
    return out
