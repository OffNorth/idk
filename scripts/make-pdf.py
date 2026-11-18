#!/usr/bin/env python3
"""
Génère docs/strategies.pdf à partir du catalogue du bot (src/catalog.js : familles, statut actif, verdict, résultat).
Usage (nécessite Python, reportlab et les polices DejaVu) :
    node -e "console.log(JSON.stringify(require('./src/catalog').catalog(require('./src/config'))))" > /tmp/catalog.json  # npm run pdf
    python3 scripts/make-pdf.py /tmp/catalog.json
"""
import datetime, json, os, struct, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak, KeepTogether
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'docs', 'strategies.pdf')
pdfmetrics.registerFont(TTFont('DV', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DVB', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
addMapping('DV', 0, 0, 'DV'); addMapping('DV', 1, 0, 'DVB'); addMapping('DV', 0, 1, 'DV'); addMapping('DV', 1, 1, 'DVB')

INK, MUTED, GOLD, LINE = (colors.HexColor(c) for c in ('#1f2937', '#6b7280', '#b45309', '#e5e7eb'))
title = ParagraphStyle('t', fontName='DVB', fontSize=20, leading=24, textColor=INK, spaceAfter=4)
sub = ParagraphStyle('s', fontName='DV', fontSize=9.5, leading=13, textColor=MUTED)
h2 = ParagraphStyle('h2', fontName='DVB', fontSize=13, leading=17, textColor=GOLD, spaceBefore=10, spaceAfter=5)
body = ParagraphStyle('b', fontName='DV', fontSize=9, leading=12.5, textColor=INK)
cell = ParagraphStyle('c', fontName='DV', fontSize=8, leading=10.2, textColor=INK)
cellb = ParagraphStyle('cb', parent=cell, fontName='DVB')
head = ParagraphStyle('h', fontName='DVB', fontSize=8, leading=10, textColor=colors.white)

STATUS = {
    'OR+NAS': ('Active · Or + Nasdaq', '#bbf7d0'), 'OR': ('Active · Or', '#fde68a'), 'NAS': ('Active · Nasdaq', '#bfdbfe'),
    'ESSAI': ('Active · à l’essai', '#e9d5ff'), 'DISPO': ('Disponible', '#f3f4f6'), 'REJ': ('Rejetée', '#fee2e2'), 'REF': ('Référence', '#e5e7eb'),
}
TF = {'1d': '1 jour', '6h': '6 h', '1h': '1 h', '5m': '5 min', '1m': '1 min'}
esc = lambda s: str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def status(s):
    a = s['active']
    if s['id'] == 'hold':
        return 'REF'
    if a:
        if s['verdict'] == 'essai':
            return 'ESSAI'
        return 'OR+NAS' if len(a) == 2 else 'OR' if a[0] == 'gold' else 'NAS'
    return 'REJ' if s['verdict'] == 'rejet' else 'DISPO'


def table_for(rows):
    data = [[Paragraph(x, head) for x in ('Stratégie', 'Id', 'Bougies', 'Statut', 'Résultat')]]
    style = [('BACKGROUND', (0, 0), (-1, 0), INK), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEBELOW', (0, 1), (-1, -1), 0.4, LINE),
             ('TOPPADDING', (0, 0), (-1, -1), 3.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5), ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4)]
    for r, s in enumerate(rows, start=1):
        st = status(s)
        label, bg = STATUS[st]
        on = st in ('OR+NAS', 'OR', 'NAS', 'ESSAI')
        data.append([Paragraph(esc(s['name']), cellb if on else cell), Paragraph(f'<font color="#4b5563">{esc(s["id"])}</font>', cell),
                     Paragraph(TF.get(s['tf'], s['tf']), cell), Paragraph(label, cellb if on else cell), Paragraph(esc(s['note'] or '—'), cell)])
        style.append(('BACKGROUND', (3, r), (3, r), colors.HexColor(bg)))
    t = Table(data, colWidths=[50 * mm, 22 * mm, 16 * mm, 30 * mm, 62 * mm], repeatRows=1)
    t.setStyle(TableStyle(style))
    return t


def png_size(path):
    with open(path, 'rb') as f:
        f.read(16)
        return struct.unpack('>II', f.read(8))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('DV', 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(15 * mm, 10 * mm, 'Gold Paper Bot · simulation uniquement, aucun argent réel · résultats passés ≠ résultats futurs')
    canvas.drawRightString(195 * mm, 10 * mm, f'page {doc.page}')
    canvas.restoreState()


cat = json.load(open(sys.argv[1], encoding='utf-8'))
strats = [s for s in cat if s['id'] != 'hold']
active = [s for s in strats if s['active']]
n_gold = sum('gold' in s['active'] for s in strats)
n_nas = sum('nas100' in s['active'] for s in strats)
n_dispo = sum(status(s) == 'DISPO' for s in strats)
n_rej = sum(status(s) == 'REJ' for s in strats)
months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
d = datetime.date.today()

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=17 * mm,
                        title='Stratégies du bot de paper trading', author='Gold Paper Bot')
story = [Paragraph('Stratégies du bot de paper trading', title),
         Paragraph(f'Or (PAXG / future GC=F) et Nasdaq 100 (indice ^NDX) · état au {d.day} {months[d.month - 1]} {d.year}', sub), Spacer(1, 8)]
summary = [
    (len(strats), 'stratégies codées et testées (+ la référence « garder le marché »)'),
    (len(active), f'actives en direct : {n_gold} sur l’or, {n_nas} sur le Nasdaq (certaines sur les deux)'),
    (n_dispo, 'positives mais pas actives : activables dans le .env (GOLD_STRATEGIES, NAS_STRATEGIES)'),
    (n_rej, 'rejetées aux tests (perdantes ou nulles après frais)'),
]
st = Table([[Paragraph(f'<font name="DVB" size="16" color="#b45309">{a}</font>', body), Paragraph(b, body)] for a, b in summary], colWidths=[18 * mm, 162 * mm])
st.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('BOTTOMPADDING', (0, 0), (-1, -1), 2), ('TOPPADDING', (0, 0), (-1, -1), 2)]))
story += [st, Spacer(1, 8), Paragraph('À retenir', h2)]
for line in [
    'Les stratégies journalières (tendance de long terme, saisons) sont les plus solides ; en bougies d’1 heure et moins, presque tout perd à cause des frais et du bruit.',
    'Or : « saison OU tendance » et la saison (août → février) font presque aussi bien que garder l’or, avec beaucoup moins de baisse.',
    'Nasdaq : garder l’indice reste devant (+17 %/an depuis 2010) ; les stratégies évitent surtout une partie des krachs (croix dorée +10,1 %/an).',
    'Scalp : sur 15 stratégies en bougies 1 à 5 min, une seule tient : RSI 2 dans la tendance 1 h sur l’or 5 min (≈ 2,7 trades/jour, positive chaque année 2020–2026, gain faible). Rien n’est validé en scalp sur le Nasdaq (données gratuites trop courtes).',
    'Le paper trading en direct, publié dans le groupe Telegram, sert à confirmer ces résultats sans risquer d’argent.',
]:
    story.append(Paragraph('• ' + line, body))

story.append(Paragraph('Comment lire les résultats', h2))
story.append(Paragraph(
    'Stratégies journalières : rendements <b>par an, gains réinvestis</b>, 1 000 $ au départ. <b>Or</b> : 2001 → 2026 (future GC=F), frais 0,05 % par côté. '
    '<b>Nasdaq</b> : 2010 → 2026 (^NDX), frais 0,01 % par côté + financement CFD de 6 %/an. Chaque stratégie est <b>choisie</b> sur une première période puis '
    '<b>vérifiée</b> sur une période non utilisée pour choisir. <b>Scalp</b> : PAXG 5 min 2020–2026 et 1 min sur 12 mois, futures Yahoo sur 30 à 60 jours, '
    'frais réalistes de 0,004 % (or) et 0,003 % (Nasdaq) par côté.', body))
story.append(Spacer(1, 4))
keys = ('OR+NAS', 'OR', 'NAS', 'ESSAI', 'DISPO', 'REJ')
legend = Table([[Paragraph(STATUS[k][0], cellb)] for k in keys], colWidths=[45 * mm], hAlign='LEFT')
legend.setStyle(TableStyle([('TOPPADDING', (0, 0), (-1, -1), 2), ('BOTTOMPADDING', (0, 0), (-1, -1), 2)] +
                           [('BACKGROUND', (0, i), (0, i), colors.HexColor(STATUS[k][1])) for i, k in enumerate(keys)]))
story.append(legend)
ref = next((s for s in cat if s['id'] == 'hold'), None)
if ref:
    story.append(Paragraph('Références', h2))
    story.append(Paragraph(f'<b>Garder le marché</b> : {esc(ref["note"])}. Une stratégie qui ne fait pas mieux, ou pas avec moins de risque, n’apporte rien.', body))

ORDER = ['Premières stratégies', 'Maison', 'Analyse technique', 'Tendance multi-horizons', 'Spécifiques à l’or', 'Spécifiques au Nasdaq',
         'Intraday Nasdaq', 'Scalp 2e série', 'Scalp (1–5 min)']
rank = lambda f: next((i for i, k in enumerate(ORDER) if f.startswith(k)), len(ORDER))
families = sorted({s['family'] for s in strats}, key=rank)
for i, fam in enumerate(families, start=1):
    rows = [s for s in strats if s['family'] == fam]
    story.append(KeepTogether([Paragraph(f'{i}. {esc(fam)} ({len(rows)})', h2), table_for(rows)]))

# Comptes FTMO simulés (réglages lus dans src/config.js)
import subprocess
fc = json.loads(subprocess.run(['node', '-e', "const c=require('./src/config');console.log(JSON.stringify({g:c.ftmoStrategies,gr:c.ftmoRisk,n:c.ftmoNasStrategies,nr:c.ftmoNasRisk,ds:c.ftmoDayStop}))"],
                               cwd=ROOT, capture_output=True, text=True, check=True).stdout)
ids = lambda l: ', '.join(x.split(':', 1)[-1] for x in l)
story.append(PageBreak())
story.append(Paragraph('Comptes FTMO simulés', h2))
story.append(Paragraph(
    'Challenge FTMO en 2 étapes (règles 2026) sur 100 000 $ : <b>+10 %</b> puis <b>+5 %</b>, au moins 4 jours de trading par étape ; échec si la perte du jour '
    'atteint 5 % (positions ouvertes comprises) ou la perte totale 10 %. Taille de chaque trade = risque ÷ distance au stop, levier max 1:30, '
    f'plus de nouveau trade dans la journée après −{fc["ds"]:g}\u00a0%. Taux de réussite mesuré en lançant un challenge chaque semaine de l’historique.', body))
story.append(Spacer(1, 5))
ft = [[Paragraph(x, head) for x in ('Compte', 'Stratégies suivies', 'Risque / trade', 'Réussite')],
      [Paragraph('<b>Or</b> (scalps 5 et 15 min)', cell), Paragraph(esc(ids(fc['g'])), cell), Paragraph(f'{fc["gr"]:g} %', cell),
       Paragraph('≈ 80 % en moins de 6 mois sur 2020–2026, 59 % sur la période récente (PAXG 5 min)', cell)],
      [Paragraph('<b>Nasdaq</b> (journalier)', cell), Paragraph(esc(ids(fc['n'])), cell), Paragraph(f'{fc["nr"]:g} %', cell),
       Paragraph('en moins d’un an : 42 % (1985–1999), 43 % (2000–2009), <b>39 % (2010–2026, vérification)</b> ; ancien portefeuille 21 %', cell)]]
t = Table(ft, colWidths=[30 * mm, 62 * mm, 20 * mm, 68 * mm], repeatRows=1)
t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), INK), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEBELOW', (0, 1), (-1, -1), 0.4, LINE),
                       ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
story += [t, Spacer(1, 5), Paragraph(
    'Nasdaq : les stratégies journalières tradent trop rarement pour faire +10 % en un an à faible risque (0 % de réussite à 0,5 ou 1 %) ; à 3 %, environ '
    '6 challenges sur 10 échouent encore, surtout sur la perte du jour quand plusieurs positions perdent ensemble. Choix sur 1985–2009, vérification sur 2010–2026.', body)]

story.append(PageBreak())
story.append(Paragraph('Historiques simulés des stratégies actives', h2))
story.append(Paragraph('Chaque stratégie part de 1 000 $, gains réinvestis, frais inclus. Légende et rendement annuel dans chaque image ; pointillé gris : garder le marché.', body))
for img, cap in [('historique-or-2001.png', 'Or, 2001 → 2026 (future GC=F)'), ('historique-nasdaq-2010.png', 'Nasdaq 100, 2010 → 2026 (financement CFD 6 %/an inclus)')]:
    path = os.path.join(ROOT, 'docs', img)
    w, h = png_size(path)
    width = 180 * mm
    story += [Spacer(1, 6), KeepTogether([Paragraph(f'<b>{cap}</b>', body), Spacer(1, 3), Image(path, width=width, height=width * h / w)])]

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f'PDF écrit : {OUT} ({len(strats)} stratégies, {len(active)} actives, {n_dispo} disponibles, {n_rej} rejetées)')
