#!/usr/bin/env python3
"""Rapport hebdomadaire (analyse du dimanche) en PDF.
Usage : python3 scripts/weekly-report.py stats.json analysis.json  → docs/weekly/report-AAAA-MM-JJ.pdf (+ docs/weekly/latest.pdf)
stats.json : sortie de scripts/weekly-stats.js. analysis.json : texte écrit par l'analyste, en français :
  { "summary": "…", "win": ["…"], "lose": ["…"], "ai": ["…"], "watch": ["…"], "suggestions": ["…"] }
Le HTML simple de reportlab est accepté dans les textes (<b>, <i>)."""
import json, os, shutil, sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
from reportlab.graphics.shapes import Drawing, Rect, String, Line
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping

S = json.load(open(sys.argv[1], encoding='utf-8'))
A = json.load(open(sys.argv[2], encoding='utf-8'))
DIR = os.path.join(os.path.dirname(__file__), '..', 'docs', 'weekly')
os.makedirs(DIR, exist_ok=True)
OUT = os.path.join(DIR, f"report-{S['to']}.pdf")
pdfmetrics.registerFont(TTFont('DV', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DVB', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
addMapping('DV', 0, 0, 'DV'); addMapping('DV', 1, 0, 'DVB'); addMapping('DV', 0, 1, 'DV'); addMapping('DV', 1, 1, 'DVB')
INK, MUTED, ACCENT, LINE, SOFT, ZEBRA = (colors.HexColor(c) for c in ('#1d2330', '#667085', '#6e45c9', '#e6e8ee', '#f4f0fd', '#fafafc'))
GREEN, RED = colors.HexColor('#1a7f5a'), colors.HexColor('#c2413b')
title = ParagraphStyle('t', fontName='DVB', fontSize=22, leading=28, textColor=INK, spaceAfter=4)
sub = ParagraphStyle('s', fontName='DV', fontSize=10, leading=14.5, textColor=MUTED, spaceAfter=8)
h2 = ParagraphStyle('h2', fontName='DVB', fontSize=13, leading=17, textColor=ACCENT, spaceBefore=12, spaceAfter=5)
body = ParagraphStyle('b', fontName='DV', fontSize=9.4, leading=13.6, textColor=INK, spaceAfter=3)
bullet = ParagraphStyle('bl', parent=body, leftIndent=11, bulletIndent=1, spaceAfter=3.5)
note = ParagraphStyle('n', parent=body, fontSize=8.2, leading=11.5, textColor=MUTED, spaceBefore=2)
cell = ParagraphStyle('c', fontName='DV', fontSize=8, leading=10.5, textColor=INK)
head = ParagraphStyle('h', fontName='DVB', fontSize=7.6, leading=9.6, textColor=ACCENT)
W = A4[0] - 32 * mm
money = lambda v: '—' if v is None else f"{'+' if v > 0 else '−' if v < 0 else ''}{abs(round(v)):,} $".replace(',', ' ')
fr = lambda d: f"{d[8:10]}/{d[5:7]}"


def table(rows, widths):
    widths = [w * W / sum(widths) for w in widths]
    t = Table([[Paragraph(str(x), head) for x in rows[0]]] + [[Paragraph(str(x), cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), SOFT), ('LINEBELOW', (0, 0), (-1, 0), 0.8, ACCENT),
                           ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, ZEBRA]), ('LINEBELOW', (0, 1), (-1, -1), 0.35, LINE),
                           ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
    return t


def bars(by_day, label):
    days = sorted(by_day)
    if not days:
        return Paragraph(f'{label} : aucun trade cette semaine.', note)
    vals = [by_day[d]['total'] for d in days]
    w, h = W, 40 * mm
    dr = Drawing(w, h)
    top, bot = max(max(vals), 1), min(min(vals), -1)
    scale = (h - 18 * mm) / (top - bot)
    y0 = 10 * mm + (-bot) * scale
    bw = (w - 20 * mm) / max(len(days), 5)
    dr.add(Line(10 * mm, y0, w, y0, strokeColor=LINE, strokeWidth=0.6))
    for i, (d, v) in enumerate(zip(days, vals)):
        x = 12 * mm + i * bw
        dr.add(Rect(x, min(y0, y0 + v * scale), bw * 0.6, abs(v * scale) or 0.5, fillColor=GREEN if v > 0 else RED, strokeColor=None))
        dr.add(String(x + bw * 0.3, 3 * mm, fr(d), fontName='DV', fontSize=6.5, fillColor=MUTED, textAnchor='middle'))
        dr.add(String(x + bw * 0.3, (y0 + v * scale + 2) if v >= 0 else (y0 + v * scale - 8), money(v), fontName='DV', fontSize=6.3, fillColor=INK, textAnchor='middle'))
    dr.add(String(0, h - 5, label, fontName='DVB', fontSize=8, fillColor=ACCENT))
    return dr


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, A4[0] - 16 * mm, 13 * mm)
    canvas.setFont('DV', 7.2); canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 9 * mm, f"Analyse du dimanche · bot {S.get('version', '')} · simulation, argent fictif · les résultats passés ne garantissent rien")
    canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, str(doc.page))
    canvas.restoreState()


def bullets(items):
    return [Paragraph(x, bullet, bulletText='•') for x in items or []]


NAMES = {'ftmo': 'FTMO 100K', 'gold': 'FTMO 100K', 'lucid': 'Lucid évaluation intraday', 'lucid2': 'Lucid évaluation daily', 'lucid3': 'Lucid évaluation combinée', 'lucidf': 'Lucid financé'}
story = [Paragraph('Analyse de la semaine', title), Paragraph(f"Du {fr(S['from'])} au {fr(S['to'])} · bot {S.get('version', '')} · comptes simulés FTMO et Lucid", sub)]
if A.get('summary'):
    story.append(Paragraph(A['summary'], body))
rows = [('Compte', 'Solde (essai)', 'Semaine : trades (gagnants)', 'Semaine', 'Gain moyen / perte moyenne', 'Depuis le début')]
for k, a in S['accounts'].items():
    wk = a['week']
    rows.append((NAMES.get(k, a.get('label', k)), f"{a['equity']:,} $ ({a['gainPct']:+.1f} %) · n° {a['attempt']}{' financé' if a['phase'] == 'funded' else ''}".replace(',', ' '),
                 f"{wk['trades']} ({wk['wins']})", f"<b>{money(wk['pnl'])}</b>", f"{money(wk['avgWin'])} / {money(wk['avgLoss'])}", money(a['sinceStart']['pnl'])))
story += [Paragraph('Les comptes', h2), table(rows, [34, 34, 22, 16, 26, 18])]
for k in ('ftmo', 'lucid'):
    if k in S['accounts']:
        story += [Spacer(1, 4), bars(S['accounts'][k]['week']['byDay'], f"{NAMES[k]} : gain et perte par jour")]
story += [Paragraph('Pourquoi on gagne', h2)] + bullets(A.get('win'))
story += [Paragraph('Pourquoi on perd', h2)] + bullets(A.get('lose'))
P = S['paper']['week']
rows = [('Stratégie (paper)', 'Trades', 'Gagnants', 'Total en R')] + [(k, v['n'], v['wins'], f"{v['total']:+.2f}") for k, v in sorted(P['byStrategy'].items(), key=lambda kv: -kv[1]['total'])]
story.append(KeepTogether([Paragraph('Les stratégies cette semaine (paper)', h2),
                           Paragraph(f"{P['trades']} trades clôturés, {P['wins']} gagnants, <b>{P['totalR']:+.1f} R</b> au total (R = le risque prévu du trade).", body),
                           table(rows, [70, 16, 18, 20]) if len(rows) > 1 else Paragraph('Aucun trade paper cette semaine.', note)]))
sc = S.get('aiScore') or {}
story += [Paragraph("L'IA validatrice", h2)]
if sc:
    g = lambda x: f"{x['n']} signaux, {x['winPct']} % gagnants, {x['avgR']:+.2f} R en moyenne" if x and x.get('n') else 'aucun'
    story.append(Paragraph(f"{sc.get('judged', 0)} signaux jugés depuis le début, {sc.get('closed', 0)} clôturés (réapprentissage à partir de 150). "
                           f"Acceptés : {g(sc.get('accepted'))}. Qu'elle refuserait : {g(sc.get('refused'))}.", body))
story += bullets(A.get('ai'))
story += [Paragraph('À surveiller', h2)] + bullets(A.get('watch'))
story += [Paragraph('Propositions', h2)] + bullets(A.get('suggestions'))
story.append(Paragraph("Rapport écrit chaque dimanche par l'analyste automatique (session Claude planifiée), à partir des données publiées par le bot "
                       "sur le site. Il ne change rien au bot : les propositions attendent ton accord.", note))
doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title=f"Analyse de la semaine {S['to']}", author='Bot de paper trading')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
shutil.copyfile(OUT, os.path.join(DIR, 'latest.pdf'))
print('PDF écrit :', os.path.abspath(OUT))
