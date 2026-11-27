#!/usr/bin/env python3
"""Compte rendu des 10 premiers jours du bot (17 → 27/11/2026), à partir de /export et des trades archivés du site.
Usage : python3 scripts/report-10days.py stats.json  → docs/report-10-days.pdf"""
import json, os, sys
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
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'report-10-days.pdf')
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
money = lambda v: f"{'+' if v > 0 else '−' if v < 0 else ''}{abs(round(v)):,} $".replace(',', ' ')


def table(rows, widths):
    widths = [w * W / sum(widths) for w in widths]
    t = Table([[Paragraph(x, head) for x in rows[0]]] + [[Paragraph(str(x), cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), SOFT), ('LINEBELOW', (0, 0), (-1, 0), 0.8, ACCENT),
                           ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, ZEBRA]), ('LINEBELOW', (0, 1), (-1, -1), 0.35, LINE),
                           ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
    return t


def bars(by_day, label):
    """Gain / perte par jour (barres vertes / rouges)."""
    days = sorted(by_day)
    vals = [by_day[d]['pnl'] for d in days]
    w, h = W, 46 * mm
    d = Drawing(w, h)
    top = max(max(vals), 1); bot = min(min(vals), -1)
    y0 = 10 * mm + (h - 18 * mm) * (-bot) / (top - bot)
    scale = (h - 18 * mm) / (top - bot)
    bw = (w - 20 * mm) / len(days)
    d.add(Line(10 * mm, y0, w, y0, strokeColor=LINE, strokeWidth=0.6))
    for i, (day, v) in enumerate(zip(days, vals)):
        x = 12 * mm + i * bw
        d.add(Rect(x, min(y0, y0 + v * scale), bw * 0.6, abs(v * scale) or 0.5, fillColor=GREEN if v > 0 else RED, strokeColor=None))
        d.add(String(x + bw * 0.3, 3 * mm, day[5:].replace('-', '/'), fontName='DV', fontSize=6.5, fillColor=MUTED, textAnchor='middle'))
        d.add(String(x + bw * 0.3, (y0 + v * scale + 2) if v >= 0 else (y0 + v * scale - 8), money(v), fontName='DV', fontSize=6.3, fillColor=INK, textAnchor='middle'))
    d.add(String(0, h - 5, label, fontName='DVB', fontSize=8, fillColor=ACCENT))
    return d


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.5)
    canvas.line(16 * mm, 13 * mm, A4[0] - 16 * mm, 13 * mm)
    canvas.setFont('DV', 7.2); canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 9 * mm, 'Bot de paper trading · simulation, argent fictif · les résultats passés ne garantissent rien')
    canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, str(doc.page))
    canvas.restoreState()


F, L, P, AI = S['accounts']['ftmo'], S['accounts']['lucid'], S['paper'], S['ai']
story = [Paragraph('Compte rendu des 10 premiers jours', title),
         Paragraph('Du 17 au 27 novembre 2026 · comptes simulés FTMO 100K et LucidFlex 50K · 37 trades paper, 30 trades sur les comptes', sub)]

story += [Paragraph('En bref', h2), table([
    ('Compte', 'Résultat', 'Trades (gagnants)', 'Gain moyen / perte moyenne'),
    ('FTMO 100K, challenge n° 2 (19 → 25/11)', '<b>+10,1 %</b> (110 126 $) en 5 jours, puis /reset', '17 (8)', '—'),
    ('LucidFlex 50K, évaluation n° 1 (20 → 25/11)', '<b>+7,2 %</b> (53 575 $) en 3 jours, puis /reset', '7 (3)', '—'),
    ('FTMO depuis le reset (27/11)', '−0,9 % (99 115 $)', '5 (0)', '—'),
    ('Lucid depuis le reset (27/11)', '−0,7 % (49 647 $)', '1 (0)', '—'),
    ('<b>FTMO, total des 10 jours</b>', f"<b>{money(F['pnl'])}</b>", f"{F['n']} ({F['wins']})", '+1 554 $ / −228 $'),
    ('<b>Lucid, total des 10 jours</b>', f"<b>{money(L['pnl'])}</b>", f"{L['n']} ({L['wins']})", '+1 470 $ / −237 $'),
], [62, 52, 28, 38]), Spacer(1, 4), Paragraph(
    'On gagne peu souvent (36 % des trades sur FTMO, 38 % sur Lucid), mais un gain vaut en moyenne <b>6 à 7 pertes</b>. '
    'C\'est le profil voulu des stratégies : petites pertes coupées vite, gros gains laissés courir. Mais avec si peu de trades, '
    '<b>tout le résultat tient à deux journées</b> (voir plus bas).', body)]

story += [Paragraph('Gain et perte par jour', h2), bars(F['byDay'], 'Compte FTMO 100K'), Spacer(1, 3), bars(L['byDay'], 'Compte LucidFlex 50K')]

story += [Paragraph('Pourquoi on gagne', h2)]
for b in [
    '<b>Deux journées de forte tendance font tout le gain.</b> Le 20/11, le Nasdaq a chuté toute la journée : « sortie de la zone de bruit » '
    '(n_noise) l\'a vendu et a gardé la position jusqu\'à 15 h 55 : <b>+7 290 $ sur FTMO (17 fois le risque)</b> et <b>+3 583 $ sur Lucid</b>. '
    'Le 19/11, la cassure de Londres sur l\'or (g_orb30) a vendu au bon moment : <b>+3 158 $</b>. Sans ces deux trades, FTMO ferait '
    '<b>−1 204 $</b> et Lucid <b>−939 $</b>.',
    '<b>Les ventes ont payé</b> : la semaine du 18 au 21/11 était en baisse (Nasdaq de 26 800 à 25 050). Sur FTMO, 13 ventes ont rapporté '
    f"{money(F['bySide']['short']['pnl'])}, 9 achats ont coûté {money(F['bySide']['long']['pnl'])}. En paper, toutes stratégies : ventes "
    f"{P['bySide']['short']['sumR']:+.1f} R, achats {P['bySide']['long']['sumR']:+.1f} R.",
    '<b>Laisser courir les gagnants</b> : les sorties « signal de sortie » (on garde tant que la tendance tient) font '
    f"{money(F['byReason']['signal de sortie']['pnl'])} sur 10 trades, quand les stops font {money(F['byReason']['stop loss']['pnl'])} sur 10. "
    'Les pertes restent petites (≈ 1 fois le risque prévu) : la gestion du risque a fonctionné.',
    '<b>g_mom8</b> (« le matin de Londres donne la direction de l\'après-midi ») est la plus régulière : 4 gagnants sur 6 sur FTMO.',
]:
    story.append(Paragraph(b, bullet, bulletText='•'))

story += [Paragraph('Pourquoi on perd', h2)]
for b in [
    '<b>Les cassures d\'ouverture de l\'or dans un marché sans direction.</b> « Écart d\'ouverture qui continue » (g_gap) : 0 gagnant sur 4 '
    '(−1 035 $). Le 27/11, cinq achats d\'or ont tous touché leur stop (−884 $) : le prix est monté après l\'ouverture de Londres puis est retombé.',
    '<b>Le même mouvement compté plusieurs fois.</b> Le 27/11 à 8 h 15, g_orb30, g_orb60 et g_asiabrk ont acheté l\'or au même prix '
    '(3 678,4) : une seule idée, trois positions. La règle « plusieurs positions → moins » les a déjà réduites (× 0,5 et × 0,25), sinon la perte '
    'aurait été environ deux fois plus forte.',
    '<b>Cassures du Nasdaq contre la tendance</b> : n_orb5s (cassure vers le bas des 5 premières minutes) 0 sur 3 en paper (−3,1 R), '
    'n_mom10 1 sur 4. Elles ont vendu dans la remontée du 24 au 26/11.',
    '<b>Aucun trade journalier en 10 jours</b> : les stratégies journalières (RSI 2, Double 7, 3 jours de baisse…) achètent des replis au-dessus '
    'de la moyenne 200 jours ; la chute du 18 au 21/11 ne les a pas déclenchées dans les règles. Les comptes Lucid daily et combiné attendent '
    'donc leur premier trade. C\'est normal sur 10 jours, pas un bug.',
    '<b>La règle du meilleur jour</b> : le challenge FTMO n° 2 était à +10,1 %, mais le 20/11 pesait 75 % du gain (maximum 50 %) : il aurait '
    'fallu ≈ 15 100 $ de gain au total pour valider. Sur Lucid, le 20/11 faisait plus de 100 % du gain (maximum 40 %). Un seul très gros jour '
    'ne suffit pas, il faut des jours réguliers.',
]:
    story.append(Paragraph(b, bullet, bulletText='•'))

rows = [('Stratégie (paper, 1 000 $ par stratégie)', 'Trades', 'Gagnants', 'Total en R')]
for k, v in sorted(P['byStrategy'].items(), key=lambda kv: -kv[1]['sumR']):
    rows.append((k, v['n'], v['w'], f"{v['sumR']:+.2f}"))
story += [KeepTogether([Paragraph('Toutes les stratégies en paper', h2), Paragraph(
    f"{P['n']} trades clôturés du {P['first'][8:]}/11 au {P['last'][8:]}/11, {P['wins']} gagnants, <b>{P['sumR']:+.1f} R</b> au total "
    '(R = le risque prévu du trade). Les variantes Lucid « objectif 0,5 R » du Nasdaq ont gagné 8 trades sur 9, mais prennent peu à chaque fois (≈ +0,5 R).', body),
    table(rows, [70, 16, 18, 20])])]

wp, lp = AI['winP'], AI['loseP']
story += [KeepTogether([Paragraph('L\'IA validatrice', h2), Paragraph(
    f"{AI['judged']} signaux jugés en 10 jours, <b>aucun refusé</b> (seuil 39 %). Probabilité moyenne donnée par l'IA : "
    f"<b>{sum(wp) / len(wp):.0%}</b> pour les trades gagnants, <b>{sum(lp) / len(lp):.0%}</b> pour les perdants : elle trie un peu dans le bon "
    'sens, mais 17 signaux ne prouvent rien. Elle n\'a pas encore réappris (version d\'origine) : il lui faut 150 signaux clôturés.', body),
    Paragraph('<b>Améliorations faites (v5.41)</b>', body)])]
for b in [
    'Elle apprend maintenant de <b>tous les signaux paper</b> (toutes les stratégies, suivies ou non par les comptes) et des comptes Lucid : '
    'environ 2 à 3 fois plus d\'exemples, donc un premier réapprentissage en quelques semaines au lieu de plusieurs mois.',
    'Les résultats des signaux sont notés <b>à chaque passage</b> (avant : seulement le dimanche).',
    '<b>Bilan de l\'IA en direct</b> dans /adapt et /export : réussite et R moyen des signaux qu\'elle accepte, de ceux qu\'elle refuserait, '
    'et par tranche de probabilité.',
    '/export contient maintenant les évaluations Lucid daily et combinée, et les trades des challenges précédents.',
]:
    story.append(Paragraph(b, bullet, bulletText='•'))

story += [Paragraph('À retenir et à surveiller', h2)]
for b in [
    '<b>10 jours, c\'est très peu</b> : 30 trades sur les comptes, dont deux font tout le gain. Il faut au moins 1 à 2 mois avant de juger une '
    'stratégie, et comparer ses résultats à ses backtests (PDF des stratégies).',
    '<b>Ce qui marche comme prévu</b> : pertes petites et coupées, gros gains sur les journées de tendance, Binance en temps réel pour l\'or.',
    '<b>Piste à tester</b> : une seule position quand plusieurs stratégies or entrent au même moment au même prix (le 27/11, 3 achats identiques).',
    '<b>Piste à tester</b> : g_gap (0 sur 4) et n_orb5s (0 sur 3) sont à surveiller ; on ne retire rien sur si peu de trades.',
    'Les comptes ont été remis à zéro le 26/11 (/reset) : les comptes Lucid daily, combiné et financé, ajoutés depuis, n\'ont encore aucun trade.',
]:
    story.append(Paragraph(b, bullet, bulletText='•'))
story.append(Paragraph('Données : fichier /export du 27/11/2026 à 22 h 11 (v5.39) et trades archivés publiés sur le site. Montants des comptes en '
                       'dollars simulés ; trades paper en R.', note))

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title='Compte rendu des 10 premiers jours', author='Bot de paper trading')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print('PDF écrit :', os.path.abspath(OUT))
