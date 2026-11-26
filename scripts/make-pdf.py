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
    out = ([CondPageBreak(150 * mm), Spacer(1, 7 * mm)] if soft else [PageBreak()]) + [Paragraph(f'PARTIE {n}', kicker), Paragraph(name, parth), HRFlowable(width='100%', thickness=0.6, color=LINE, spaceBefore=4, spaceAfter=8)]
    if intro:
        out.append(Paragraph(intro, sub))
    return out

# Statut : une pastille par famille de statut (vert actif, ambre à l'essai, gris disponible, rouge rejeté)
STATUS = {
    'OR+NAS': ('Active · Or + Nasdaq', '#ecfdf3', '#067647'), 'OR': ('Active · Or', '#ecfdf3', '#067647'), 'NAS': ('Active · Nasdaq', '#ecfdf3', '#067647'),
    'ESSAI': ('Active · à l’essai', '#fffaeb', '#b54708'), 'DISPO': ('Disponible', '#f2f4f7', '#475467'), 'REJ': ('Rejetée', '#fef3f2', '#b42318'),
    'REF': ('Référence', '#f2f4f7', '#475467'),
}
TF = {'1d': '1 jour', '6h': '6 h', '1h': '1 h', '5m': '5 min', '1m': '1 min'}
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
    data = [[Paragraph(x, head) for x in ('Stratégie', 'Id', 'Bougies', 'Statut', 'Résultat')]]
    style = []
    for r, s in enumerate(rows, start=1):
        st = status(s)
        label, bg, fg = STATUS[st]
        if 'spx' in s['active']:
            label += ' + S&amp;P 500'
        if 'silver' in s['active']:
            label += ' + argent'
        if 'dow' in s['active']:
            label += ' + Dow'
        if 'eurusd' in s['active']:
            label += ' + EUR/USD (essai)' if st != 'ESSAI' else ' (EUR/USD)'
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
    canvas.drawString(16 * mm, 9 * mm, 'Bot de paper trading · simulation uniquement, aucun argent réel · résultats passés ≠ résultats futurs')
    canvas.drawRightString(w - 16 * mm, 9 * mm, str(doc.page))
    if doc.page > 1:  # en-tête discret
        canvas.setFillColor(ACCENT)
        canvas.setFont('DVB', 7.2)
        canvas.drawString(16 * mm, A4[1] - 11 * mm, 'STRATÉGIES DU BOT')
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
months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
d = datetime.date.today()

n_rus = sum('russell' in s['active'] for s in strats)
n_stk = sum(any(m in s['active'] for m in ('tlt', 'googl', 'pltr', 'lly', 'ba')) for s in strats)
DATE_TXT = f'{d.day} {months[d.month - 1]} {d.year}'
doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=18 * mm, bottomMargin=19 * mm,
                        title='Stratégies du bot de paper trading', author='Bot de paper trading')
W = A4[0] - 32 * mm
story = [Spacer(1, 16 * mm), Paragraph('BOT DE PAPER TRADING · DOSSIER', kicker),
         Paragraph('Stratégies, comptes FTMO et Lucid,<br/>et guide pour trader à la main', title),
         Paragraph(f'Or, Nasdaq 100, S&amp;P 500, Dow Jones, Russell 2000, argent, EUR/USD et cinq actions · état au {DATE_TXT}', sub), Spacer(1, 9 * mm)]
kpis = [(len(strats), 'stratégies codées<br/>et testées'), (len(active), 'actives<br/>en direct'), (n_dispo, 'positives,<br/>pas activées'), (n_rej, 'rejetées<br/>aux tests')]
kt = Table([[Paragraph(f'<font name="DVB" size="24" color="{ACC}">{a}</font><br/><br/><font color="{MUT}">{b}</font>', kpi) for a, b in kpis]], colWidths=[W / 4] * 4)
kt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), SOFT), ('LINEAFTER', (0, 0), (-2, -1), 5, colors.white), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                        ('TOPPADDING', (0, 0), (-1, -1), 11), ('BOTTOMPADDING', (0, 0), (-1, -1), 11), ('LEFTPADDING', (0, 0), (-1, -1), 11)]))
story += [kt, Spacer(1, 4), Paragraph(f'Actives par marché : or {n_gold} · Nasdaq {n_nas} · S&amp;P 500 {n_spx} · Dow Jones {n_dow} · Russell 2000 {n_rus} · '
                                      f'argent {n_sil} · EUR/USD {n_eur} · actions {n_stk} (certaines sur plusieurs marchés).', ParagraphStyle('n2', parent=note, spaceBefore=6)), Spacer(1, 6 * mm)]
story.append(Paragraph('À retenir', h2))
for line in [
    'Les stratégies journalières (tendance de long terme, saisons) sont les plus solides ; en bougies d’1 heure et moins, presque tout perd à cause des frais et du bruit.',
    'Les comptes sont réglés sur l’historique puis vérifiés sur des années jamais vues : <b>FTMO</b> réussit ≈ 53 à 76 % des challenges en moins d’un an, '
    '<b>Lucid</b> ≈ 50 à 78 % ; environ une évaluation Lucid sur quatre réussit en 2 semaines.',
    'Plan suivi : réussir Lucid, toucher les retraits Lucid, financer avec eux des comptes FTMO (risque × 0,75 une fois financé, challenge racheté si le compte est perdu).',
    'L’IA validatrice aide sur FTMO (+3 à +7 points de réussite) mais pas sur Lucid, où elle donne seulement son avis. Order flow et ICT : rien '
    'd’exploitable après frais.',
    'Tout est simulé : le paper trading en direct, publié dans le groupe Telegram et sur le site, sert à confirmer ces résultats sans risquer d’argent.',
]:
    story.append(Paragraph(line, bullet, bulletText='•'))
story.append(Paragraph('Sommaire', h2))
toc = [('1', 'Catalogue des stratégies', 'chaque stratégie, son statut et son résultat'),
       ('2', 'Comptes FTMO et Lucid', 'règles, réglage du risque, IA, plan Lucid → FTMO'),
       ('3', 'Recherches', 'traders connus, nouveaux marchés, séances, order flow, ICT'),
       ('4', 'Le bot au quotidien', 'exécution, suivi en direct, portefeuille perso'),
       ('5', 'Guide : trader à la main', 'les règles exactes et un exemple réel par stratégie'),
       ('6', 'Historiques simulés', 'les courbes des stratégies actives')]
tt = Table([[Paragraph(f'<font name="DVB" color="{ACC}">{n}</font>', body), Paragraph(f'<b>{a}</b>', body), Paragraph(f'<font color="{MUT}">{b}</font>', body)] for n, a, b in toc],
           colWidths=[10 * mm, 60 * mm, W - 70 * mm])
tt.setStyle(TableStyle([('LINEBELOW', (0, 0), (-1, -1), 0.35, LINE), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
story.append(tt)

story += part(1, 'Catalogue des stratégies')
story.append(Paragraph('Comment lire les résultats', h2))
story.append(Paragraph(
    'Stratégies journalières : rendements <b>par an, gains réinvestis</b>, 1 000 $ au départ. <b>Or</b> : 2001 → 2026 (future GC=F), frais 0,05 % par côté. '
    '<b>Nasdaq</b> : 2010 → 2026 (^NDX), frais 0,01 % par côté + financement CFD de 6 %/an. Chaque stratégie est <b>choisie</b> sur une première période puis '
    '<b>vérifiée</b> sur une période non utilisée pour choisir. <b>Intraday</b> : or au comptant réel 2009–2026, Nasdaq / S&amp;P / Dow / Russell / argent '
    'sur 2 ans (nov. 2024 → nov. 2026), frais réalistes.', body))
keys = ('OR', 'ESSAI', 'DISPO', 'REJ')
legend = Table([[Paragraph(f'<font color="{STATUS[k][2]}">{"Active" if k == "OR" else STATUS[k][0]}</font>', cellb) for k in keys]], colWidths=[30 * mm] * 4, hAlign='LEFT')
legend.setStyle(TableStyle([('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3), ('LINEAFTER', (0, 0), (-2, -1), 4, colors.white)] +
                           [('BACKGROUND', (i, 0), (i, 0), colors.HexColor(STATUS[k][1])) for i, k in enumerate(keys)]))
story += [Spacer(1, 3), legend, Spacer(1, 2), Paragraph('« Active » précise le ou les marchés (or, Nasdaq, S&amp;P 500…) ; « à l’essai » : active sur un marché en test.', note)]
ref = next((s for s in cat if s['id'] == 'hold'), None)
if ref:
    story.append(Paragraph('Référence', h2))
    story.append(Paragraph(f'<b>Garder le marché</b> : {esc(ref["note"])}. Une stratégie qui ne fait pas mieux, ou pas avec moins de risque, n’apporte rien.', body))

ORDER = ['Premières stratégies', 'Maison', 'Analyse technique', 'Tendance multi-horizons', 'Spécifiques à l’or', 'Spécifiques au Nasdaq',
         'Intraday Nasdaq', 'Scalp 2e série', 'Scalp (1–5 min)']
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
fr = lambda v: f'{round(v, 3):g}'.replace('.', ',')
story += part(2, 'Comptes FTMO et Lucid')
story.append(Paragraph('Comptes FTMO et Lucid simulés', h2))
story.append(Paragraph(
    ('<b>Formule simulée : challenge 1 étape</b> (lancé par FTMO en février 2026 ; règles d’après des sources secondaires, à vérifier) : '
     '<b>+10 %</b> en une seule étape, au moins 4 jours de trading ; échec si la perte du jour atteint <b>3 %</b> ou si le compte perd '
     '<b>10 % depuis son plus haut</b> (perte max suiveuse) ; le meilleur jour ne doit pas dépasser la moitié du gain. '
     if fc['prog'] == '1step' else
     'Challenge FTMO en 2 étapes (règles 2026) sur 100 000 $ : <b>+10 %</b> puis <b>+5 %</b>, au moins 4 jours de trading par étape ; échec si la perte du jour '
     'atteint 5 % (positions ouvertes comprises) ou la perte totale 10 %. ') +
    'Taille de chaque trade = risque ÷ distance au stop, levier max 1:30, '
    f'plus de nouveau trade dans la journée après −{fc["ds"]:g}\u00a0%. Taux de réussite mesuré en lançant un challenge chaque semaine de l’historique.', body))
story.append(Spacer(1, 5))
ft = [[Paragraph(x, head) for x in ('Compte', 'Stratégies suivies', 'Risque / trade', 'Réussite')],
      [Paragraph('<b>Or</b> (scalps 5 et 15 min)', cell), Paragraph(esc(ids(fc['g'])), cell), Paragraph(f'{fc["gr"]:g} %', cell),
       Paragraph('≈ 80 % en moins de 6 mois sur 2020–2026, 59 % sur la période récente (PAXG 5 min)', cell)],
      [Paragraph('<b>Nasdaq</b> (journalier)', cell), Paragraph(esc(ids(fc['n'])), cell), Paragraph(f'{fc["nr"]:g} %', cell),
       Paragraph('en moins d’un an : 42 % (1985–1999), 43 % (2000–2009), <b>39 % (2010–2026, vérification)</b> ; ancien portefeuille 21 %', cell)]]
if fc['cb']:
    # Compte unique or + Nasdaq (npm run ftmo-combo)
    ft = [ft[0], [Paragraph('<b>Compte unique Or + Nasdaq</b> (celui du bot)', cell), Paragraph(esc(ids(fc['g'])) + ' · ' + esc(ids(fc['n'])), cell),
                  Paragraph(f'{fc["gr"]:g} % (journalières) · {fc["ir"]:g} % (intraday)', cell),
                  Paragraph(('Or réel (HistData 2009–2026), Nasdaq, S&amp;P 500, EUR/USD ; ≈ 2,8 positions intraday par jour (séances d’Asie et '
                             'de New York sur l’or, Crabel NR7 sur le S&amp;P 500). Réussite en moins d’un an avec le réglage actuel (taille normale, '
                             'divisée par 2 avec 2 positions ouvertes, stop suiveur, évaluation « comme Lucid ») : <b>53 %</b> (2009–2019), <b>58 %</b> (2020–2026), '
                             '<b>76 %</b> (nov. 2024 → nov. 2026, intraday compris), en ≈ 51 j médians sur la période récente ; chances du challenge en cours : /timemachine.')
                            if fc['prog'] == '1step' else
                            ('sept. 2020 → oct. 2024 : <b>97 % en moins de 6 mois</b> (46 j en médiane) ; 2 dernières années (vérification) : <b>46 %</b> (34 j). '
                             'Les scalps or rapportent moins depuis 2024.'), cell)]]
t = Table(ft, colWidths=[30 * mm, 62 * mm, 20 * mm, 66 * mm], repeatRows=1)
t.setStyle(tstyle())
story += [t, Spacer(1, 5)] + ([] if fc['cb'] else [Paragraph(
    'Nasdaq : les stratégies journalières tradent trop rarement pour faire +10 % en un an à faible risque (0 % de réussite à 0,5 ou 1 %) ; à 3 %, environ '
    '6 challenges sur 10 échouent encore, surtout sur la perte du jour quand plusieurs positions perdent ensemble. Choix sur 1985–2009, vérification sur 2010–2026.', body)])
story += [Spacer(1, 4), Paragraph(
    '<b>Levier et risque qui baisse.</b> Chaque trade risque une part fixe du compte (taille = risque ÷ distance au stop, levier plafonné à 1:30), '
    'divisée par 2 dès que 2 positions sont déjà ouvertes. '
    + ('En plus, <b>le risque baisse à l’approche de l’objectif</b> : × (1 − 0,75 × avance vers les +10 %), au moins × 0,4 '
       '(× 0,625 à +5 %, × 0,4 à partir de +8 %), pour protéger le gain acquis contre la perte du jour de 3 %. '
       if str(fc['sz']).startswith('objectif') else ''), body)]

def small_table(rows, widths):
    widths = [w * W / sum(widths) for w in widths]  # toujours la largeur de la page
    t = Table([[Paragraph(x, head) for x in rows[0]]] + [[Paragraph(x, cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
    # Ligne du réglage actuel (texte en gras ou « actuel ») : surlignée
    hl = [('BACKGROUND', (0, r), (-1, r), HILITE) for r, row in enumerate(rows[1:], start=1) if row[0].startswith('<b>') or 'actuel' in row[0].lower()]
    t.setStyle(tstyle(hl))
    return t

story += [Spacer(1, 3), small_table([
    ('Challenge 1 étape, réussite en moins d’un an', '2009–2019', '2020–2026', 'nov. 2024 → nov. 2026'),
    ('Risque fixe (avant)', '26 % (53 j)', '30 % (48 j)', '40 % (34 j)'),
    ('<b>Risque qui baisse à l’approche de l’objectif</b>', '<b>37 %</b> (94 j)', '<b>46 %</b> (113 j)', '<b>44 %</b> (47 j)'),
    ('Risque × 2 pour aller plus vite', '4 %', '11 %', '19 %'),
    ('<b>Taille normale, ÷ 2 avec 2 positions (actuel, 23/11/2026)</b>', '58 %', '54 %', '71 %'),
], [72 * mm, 34 * mm, 34 * mm, 40 * mm]), Spacer(1, 2), Paragraph(
    'Chiffres de chaque ligne mesurés à des dates différentes (stratégies et risques de l’époque) ; la dernière ligne avec les stratégies actuelles, '
    'avant l’ajout des séances d’Asie et de New York. La réduction à l’approche de l’objectif a été retirée à la demande : challenges ≈ 1 mois plus '
    'rapides. Elle reste disponible (FTMO_SIZING=objectif : dégressif doux). ', body), Spacer(1, 2), Paragraph(
    'Viser « 2 % par jour » n’est pas réaliste : le compte gagne en moyenne +0,1 à +0,25 % par séance ; une journée à +2,7 % arrive environ 1 séance sur 6, '
    'mais les journées à −2 % sont presque aussi fréquentes. Doubler le risque fait échouer presque tous les challenges sur la perte du jour.', body)]

story.append(Paragraph('IA validatrice des trades', h2))
story.append(Paragraph(
    'Pour chaque signal, un modèle (régression logistique entraînée sur ≈ 20 000 trades passés) estime la chance que le trade soit gagnant, avec ce '
    'qui est connu à l’entrée : forme récente de la stratégie et du marché, distance du stop, heure, jour, tendance, élan et volatilité du marché, VIX. '
    '<b>FTMO</b> : les signaux sous le seuil (≈ 20 % des signaux) ne sont pas pris ; chaque blocage est annoncé dans le groupe (« trade bloqué par '
    'l’IA »), puis son bilan quand le trade fictif se termine (l’IA a eu raison ou tort). <b>Lucid</b> : l’IA donne seulement son avis.', body))
story += [Spacer(1, 3), small_table([
    ('Réussite < 1 an · chaque année jugée par un modèle entraîné sur les années d’avant', '2009–19', '2020–26', 'nov. 24–26'),
    ('FTMO sans IA', '34 %', '43 %', '69 %'),
    ('<b>FTMO, l’IA refuse 20 % des signaux (actuel)</b>', '<b>37 %</b>', '<b>48 %</b>', '<b>76 %</b>'),
    ('<b>Lucid sans IA (actuel)</b>', '<b>46 %</b>', '<b>61 %</b>', '<b>53 %</b> · ≤ 14 j : 25 %'),
    ('Lucid, l’IA refuse 20 % des signaux', '47 %', '75 %', '33 % · ≤ 14 j : 11 % ✘'),
], [88 * mm, 28 * mm, 28 * mm, 34 * mm]), Paragraph(
    'Réglage simplifié pour ce test : comparer les lignes entre elles. Sur Lucid, le modèle ne distingue pas les bons trades (AUC 0,53, 0,5 = au hasard). '
    'Essayés sans gain fiable : modèle d’arbres, gain attendu en R, refuser 10 ou 30 % ; doser le risque selon la note fait nettement baisser la réussite.', note)]

lucid_block = [Paragraph('FTMO ou Lucid Trading ?', h2), Paragraph(
    'Les mêmes stratégies rejouées sous les règles de chaque société (sources secondaires 2026, à vérifier). <b>LucidFlex</b> : micro-futures CME en '
    'contrats entiers, objectif +6 %, <b>pas de perte du jour</b>, mais perte max de <b>2 000 $ (50K) / 3 000 $ (100K)</b> sous le plus haut solde de '
    'clôture, bloquée à capital + 100 $. Phase financée 12 mois au plus : FTMO 80 % des gains (prix remboursé), Lucid 90 %. Réglage choisi sur 2009–2019.', body)]
lucid_block += [Spacer(1, 3), small_table([
    ('Société', 'Réussite < 1 an : 2009–19 / 2020–26 / nov. 24–26', 'Gain net moyen par challenge (2020–26)'),
    ('<b>FTMO 1 étape 100K</b> (réglage du bot)', '37 % / <b>46 %</b> / 44 %', '<b>+1 113 $</b>'),
    ('FTMO 2 étapes 100K', '44 % / 33 % / 27 %', '+1 016 $'),
    ('LucidFlex 50K', '13 % / 11 % / 21 %', '−67 $'),
    ('LucidFlex 100K', '11 % / 9 % / 17 %', '−171 $'),
], [60 * mm, 70 * mm, 50 * mm]), Spacer(1, 2), Paragraph(
    'FTMO l’emporte : l’absence de perte du jour chez Lucid ne compense pas une perte max 3 à 5 fois plus serrée. '
    + (f'<b>En direct</b>, un compte <b>LucidFlex {fc["lc"] // 1000}K</b> simulé (/lucid), en contrats entiers (micros MGC, MNQ, MES, SIL, MYM ; euro en 6E standard), '
       f'règle de régularité {fc["lcons"]:g} % (meilleur jour) pendant l’évaluation. Ce tableau est l’ancienne comparaison (mêmes stratégies que FTMO) ; '
       'depuis, Lucid a ses propres réglages, voir « Stratégies pour Lucid ». ' if fc['lu'] else '')
    + 'Plusieurs challenges identiques en même temps multiplient les gains comme les pertes : les comptes prennent les mêmes trades et réussissent '
      'ou échouent ensemble.', body)]
story.append(KeepTogether(lucid_block))

if fc['aa']:
    story.append(KeepTogether([Paragraph('Adaptation automatique', h2), Paragraph(
        'Chaque dimanche, une <b>revue automatique</b> (annoncée dans le groupe) : chaque signal jugé par l’IA, pris ou refusé, est mémorisé '
        'puis étiqueté par le résultat de son trade paper ; dès 150 signaux, l’IA est <b>ré-apprise prudemment</b> (elle reste proche de son modèle '
        'd’origine tant qu’il y a peu de données) et la nouvelle version <b>n’est adoptée que si elle juge mieux</b> les signaux les plus récents. '
        'Sécurité : si ses refus récents gagnent plus que les trades qu’elle garde, elle repasse seule en observation. '
        + ('Les poids des stratégies s’adaptent aussi (réduites, renforcées, suspendues, candidates promues). ' if fc['as'] else
           'L’adaptation automatique des poids des stratégies existe mais reste coupée : elle n’a pas aidé sur l’historique. '), body),
        Spacer(1, 3), small_table([
            ('Rejoué semaine par semaine (IA de départ : 2009–2014)', '2015–2019', '2020–2026'),
            ('Sans IA', '37 %', '46 %'),
            ('IA figée', '39 %', '50 %'),
            ('<b>IA qui apprend</b> (activée)', '<b>51 %</b>', '47 %'),
            ('Stratégies qui s’adaptent', '32 % ✘', '47 %'),
            ('Tout adaptatif', '49 %', '47 %'),
        ], [100 * mm, 40 * mm, 40 * mm]), Spacer(1, 2), Paragraph('Réussite du challenge 1 étape en moins d’un an.', body)]))

story.append(KeepTogether([Paragraph('Réglage du risque (FTMO et Lucid)', h2), Paragraph(
    'Des centaines de combinaisons testées (stratégies gardées × risque intraday × risque journalier), choix sur 2009–2019 puis vérification. '
    'Les stratégies intraday ajoutent surtout de la variance : sur FTMO elles restent mais en tout petit. Lucid a ses propres réglages (voir la '
    'section suivante).', body), Spacer(1, 3), small_table([
    ('Compte', 'Réglage', '2009–2019', '2020–2026', 'nov. 24–26'),
    ('FTMO (avant)', 'intraday 0,5 % · journalières 1,5 %', '37 %', '46 %', '44 %'),
    ('FTMO (réglage du 20/11)', 'intraday 0,15 % · journalières 2 %, risque qui baisse', '64 %', '67 %', '83 %'),
    ('FTMO (24/11, + séances Asie / NY)', f'intraday {fc["ir"]:g} % · journalières {fc["gr"]:g} %, taille normale', '56 %', '47 %', '69 %'),
    ('FTMO (25/11)', 'idem, risque × 1,25, + Crabel NR7 S&amp;P 500', '50 %', '51 %', '67 % (55 j)'),
    ('<b>FTMO (actuel)</b>', '+ stop suiveur (dès +2 R, à 1 R du meilleur cours), + actions intraday', '<b>55 %</b> (80 j)', '<b>57 %</b> (76 j)', '<b>73 %</b> (76 j)'),
    ('Lucid (avant)', 'idem FTMO', '13 %', '11 %', '21 %'),
    ('Lucid (24/11)', f'journalières {fc["gr"] * fc["lm"]:g} % · Nasdaq intraday {fc["lir"]:g} %, objectif 0,5 R', '56 %', '69 %', '100 % (≈ 70 j)'),
    ('Lucid (25/11 matin)', '+ cassures, Crabel, Williams, argent, Dow (≈ 4,7 trades intraday / jour)', '55 %', '72 %', '94 % (34 j)'),
    ('Lucid (25/11 soir)', '+ Double 7 et RSI 2 S&amp;P 500, Dow en break-even — <i>avec un micro-euro M6E qui n’existe pas chez Lucid</i>', '56 % ✘', '76 % ✘', '100 % ✘'),
    ('<b>Lucid (actuel)</b>', 'euro en 6E réel (IBS EUR/USD trop gros) + plus bas 10 j Russell, Double 7 Nasdaq et argent ; intraday 0,45 %', '<b>50 %</b> (79 j)', '<b>62 %</b> (142 j)', '<b>78 %</b> (41 j)'),
], [32 * mm, 58 * mm, 30 * mm, 30 * mm, 30 * mm]), Spacer(1, 2), Paragraph(
    'Réussite en moins d’un an, sans l’IA validatrice (active en plus en direct). Stratégies d’événements testées et non retenues : veille de la Fed '
    '(Lucca & Moench 2015) et veille de jour férié (Ariel 1990) — fortes sur 2009–2012 et 2020–2026 mais perdantes sur 2017–2019.', body)]))

story.append(KeepTogether([Paragraph('Stratégies pour Lucid : moins de pertes de suite', h2), Paragraph(
    'La perte max Lucid (2 000 $ suiveuse en fin de journée) ne laisse qu’≈ 10 trades perdants d’affilée ; les stratégies de cassure (20 à 40 % de '
    'gagnants, jusqu’à 49 pertes de suite) la font échouer même quand elles gagnent en moyenne. Lucid prend donc des <b>variantes « objectif 0,5 R »</b> '
    'de l’intraday Nasdaq (même entrée, même stop, gain pris à 0,5 × le risque ; 0,75 R pour certaines cassures), puis des stratégies de traders '
    'connus et deux nouveaux marchés (sections suivantes). Liste actuelle : ' + esc(', '.join(x.split(':', 1)[-1] + ('' if x.startswith('nas100:') else ' (' + {'silver': 'argent', 'dow': 'Dow'}.get(x.split(':')[0], x.split(':')[0]) + ')') for x in fc['lis'])) + '. '
    'Le compte FTMO garde les originales. Pas d’intraday or sur Lucid (1 micro-contrat or trop gros pour la perte max).', body), Spacer(1, 3), small_table([
    ('Lucid, nov. 2024 → nov. 2026 (49 départs)', 'Gagnants', 'Pire série', 'Baisse max', 'Réussite'),
    ('Originales + n_pdlbrk (avant)', '40 %', '16 pertes', '72 R', '49 %'),
    ('<b>Objectif 0,5 R (actuel)</b>', '<b>66 %</b>', '<b>6 pertes</b>', '<b>17 R</b>', '<b>100 %</b>'),
    ('Objectif 0,3 / 0,75 / 1 R', '75 / 57 / 52 %', '6 / 9 / 15', '23 / 21 / 24 R', '92 / 82 / 67 %'),
], [62 * mm, 26 * mm, 28 * mm, 30 * mm, 34 * mm]), Spacer(1, 2), Paragraph(
    'Seulement 2 ans de données intraday Nasdaq : ces taux sont flatteurs. Sur les périodes plus anciennes (sans intraday), Lucid réussit 55 à 72 % ; '
    'compter plutôt sur 60 à 70 %. Une évaluation réussie en 2 jours relève surtout de la chance (règle du meilleur jour ≤ 40 %).', body)]))

story.append(KeepTogether([Paragraph('Plan : Lucid, retraits, puis un compte FTMO qui dure', h2), Paragraph(
    'Réussir l’évaluation Lucid vite, toucher des retraits Lucid, s’en servir pour payer un compte FTMO réglé pour durer (scaling jusqu’à 2 M$). '
    '<b>Lucid financé</b> : le réglage actuel est le meilleur pour toucher au moins un retrait (85 % en ≤ 60 jours, médiane 17 jours, ≈ 2 700 $ sur 12 mois) ; '
    'un compte Lucid financé dure rarement (perte max bloquée à capital + 100 $). <b>FTMO pendant l’évaluation</b> : réglé « comme Lucid » (intraday × 2, '
    'journée finie à +2 500 $ ou après 1 perte). <b>FTMO financé</b> : tout le risque × 0,75 (choix du 26/11/2026), plus des sorties partielles (⅓ à +1 R, ⅓ à +2 R, le reste au stop suiveur).', body),
    Spacer(1, 3), small_table([
    ('FTMO 100K financé (départ chaque semaine 2009–2023)', 'En vie 12 / 24 / 36 mois', 'Revenu trader / mois (moy. 3 ans)', 'Au moins 1 palier de scaling'),
    ('Risque × 1', '18 / 3 / 0 %', '657 $ (≈ 2 340 $ en rachetant)', '41 %'),
    ('<b>Risque × 0,75 (actuel)</b>', '<b>27 / 10 / 6 %</b>', '<b>655 $ (≈ 1 800 $ en rachetant)</b>', '<b>42 %</b>'),
    ('Risque × 0,5', '66 / 45 / 35 %', '713 $ (≈ 1 100 $ en rachetant)', '50 %'),
    ('Risque × 0,25', '100 / 100 / 100 %', '486 $', '0 %'),
    ], [62 * mm, 38 * mm, 42 * mm, 36 * mm]), Paragraph(
    'Scaling officiel FTMO (nov. 2026) : +25 % tous les 4 mois si le gain net de la période atteint +10 %, avec au moins 2 retraits ; plafond 2 M$ tous '
    'comptes confondus ; 90 % des gains pour le trader (1 étape). À × 0,25 le compte ne fait jamais +10 % en 4 mois : pas de scaling, mais il dure. « En rachetant » : '
    'nouveau challenge après chaque perte (réussite 55 %, ≈ 1,7 mois par tentative, 600 $ par tentative ratée) ; plus de risque rapporte plus en moyenne, '
    'mais le compte est perdu en ≈ 10 mois à × 0,75. Plusieurs comptes identiques : revenu × N, perdus ensemble. '
    'Sorties partielles : en compte financé seulement ; en évaluation elles n’aident pas.', note)]))

story += part(3, 'Recherches', 'Ce qui a été testé pour améliorer les comptes, retenu ou non. Chaque idée doit tenir sur toutes les périodes, frais compris.')
story.append(KeepTogether([Paragraph('Stratégies de traders connus (Lucid)', h2), Paragraph(
    'Méthodes publiées par Toby Crabel (cassure après une journée étroite, NR4 / NR7), Larry Williams (cassure de volatilité : ouverture ± k × '
    'amplitude de la veille) et Linda Raschke, testées sur le Nasdaq (QQQ séance seule, nov. 2024 → nov. 2026). Stables les deux années et ajoutées à '
    'Lucid avec un objectif proche : <b>n_crabel4_t05</b>, <b>n_crabel7_15_t075</b>, <b>n_wvb05_t075</b>, <b>n_wvb07_t05</b>, plus les cassures '
    '<b>n_orb10l_t075</b>, <b>n_orb30l_t075</b>, <b>n_or60_t05</b> : ≈ 4,7 trades intraday par jour au lieu de 0,9, évaluation en ≈ 5 semaines au lieu de ≈ 10 (nov. 24–26). '
    'Sur FTMO, ces stratégies font baisser la réussite (67 → 57 %) : seule <b>Crabel NR7 30 min sur le S&amp;P 500</b> (s_crabel7_30, +0,10 / +0,14 R par '
    'trade) y est ajoutée, sans perte de réussite. L’enchère de marché « à la Fabio Valentini » (profil de volume, scalp) n’a rien donné de stable.', body)]))

story.append(KeepTogether([Paragraph('Nouveaux marchés : argent et Dow Jones (Lucid)', h2), Paragraph(
    'Pétrole, argent, Dow Jones, Russell 2000, EUR/USD et Bitcoin testés (intraday 5 min nov. 2024 → nov. 2026, journalier depuis 2009). '
    '<b>Chaque nouveau marché fait baisser FTMO</b> : rien d’ajouté sur FTMO. Sur Lucid, l’argent (Williams 0,5, micro SIL) et le Dow Jones '
    '(momentum de la matinée, micro MYM), seulement pendant la séance de New York, gardent la même réussite et accélèrent l’évaluation.', body),
    Spacer(1, 3), small_table([
    ('Lucid, réussite < 1 an', '2009–2019', '2020–2026', 'nov. 24–26'),
    ('Sans nouveaux marchés', '55 % (85 j)', '72 % (110 j)', '94 % (37 j)'),
    ('<b>+ argent + Dow (actuel)</b>', '55 %', '72 %', '<b>94 % (34 j)</b>'),
    ('+ argent + Dow + Bitcoin', '55 %', '72 %', '88 % ✘'),
    ('+ pétrole', '—', '—', '76 % ✘'),
    ], [62 * mm, 38 * mm, 38 * mm, 42 * mm])]))

story.append(KeepTogether([Paragraph('Autres marchés et actions', h2), Paragraph(
    'DAX et Nikkei (bougies 1 h, 2 ans), livre (GBP/USD), yen (USD/JPY), obligations US (ETF TLT) et 18 grandes actions (Nvidia, Tesla, Apple, '
    'Microsoft, Amazon, Meta, Google, AMD, Netflix, Broadcom, Palantir, Coinbase, JPMorgan, Exxon, Eli Lilly, UnitedHealth, MicroStrategy, Boeing), '
    'intraday 5 min nov. 2024 → nov. 2026 et journalier depuis 2000. <b>DAX et Nikkei</b> : aucune stratégie stable. <b>Livre et yen</b> : cassures de '
    'l’ouverture de Londres stables (USD/JPY : +0,24 / +0,13 R par trade), mais elles font baisser les comptes. <b>Actions en journalier</b> '
    '(Apple, Microsoft, Google, Netflix, UnitedHealth… rentables sur 2000–09, 2010–17 et 2018–26) : elles perdent les mêmes jours que le Nasdaq et '
    'font toutes baisser FTMO. Lucid ne trade pas d’actions (futures CME seulement).', body), Spacer(1, 3), small_table([
    ('Compte FTMO, réussite < 1 an', '2009–2019', '2020–2026', 'nov. 24–26'),
    ('Actuel', '50 %', '51 %', '67 % (55 j)'),
    ('+ GBP/USD intraday', '—', '—', '65 % ✘'),
    ('+ USD/JPY intraday (Lucid : 94 → 90 %)', '—', '—', '57 % (41 j) ✘'),
    ('+ actions en journalier (selon l’action)', '40–55 % ✘', '40–54 % ✘', '49–67 %'),
    ('<b>+ TLT, Google, Palantir, Eli Lilly, Boeing intraday (ajouté)</b>', '—', '—', '<b>69 % (50 j)</b>'),
    ], [72 * mm, 32 * mm, 32 * mm, 44 * mm]), Spacer(1, 2), Paragraph(
    'Seule la dernière ligne ne fait rien baisser, pour un petit gain (≈ 1 challenge sur 50, mesuré sur 2 ans seulement) : <b>ajoutée au compte '
    'FTMO le 26/11/2026</b> (choix de l’utilisateur) — TLT : Crabel NR7 15 min · Google : Crabel NR7 30 min · Palantir : cassure 15 min, Crabel '
    'NR7 15 min, Williams 0,5 · Eli Lilly : cassure 5 min à la baisse · Boeing : Crabel NR7 15 min ; CFD, levier 1:5, ≈ 1,5 position de plus '
    'par jour (à vérifier : que ces CFD existent sur la plateforme FTMO). '
    'Conclusion des deux recherches de marchés : les comptes sont déjà bien réglés, ajouter des positions ajoute surtout de la variance.', body)]))

story.append(KeepTogether([Paragraph('Séances d’Asie et de New York', h2), Paragraph(
    '92 variantes testées sur l’or au comptant réel 2009–2026 et le Nasdaq (2 ans) : cassures d’ouverture (Tokyo, Shanghai, COMEX, New York), '
    'fixing de Londres, clôture de Londres, dernière heure, nuit asiatique, écarts d’ouverture, plus haut / plus bas de la veille, pré-ouverture, '
    'Nasdaq la nuit (future NQ=F). Retenues sur le compte FTMO : <b>g_asiabrk</b> (cassure du range de la nuit asiatique à l’ouverture de Londres : '
    '+20 / +13 / +16 % sur 3 tranches) et <b>g_nypdl</b> (cassure du plus haut / plus bas de la veille sur l’or pendant New York : +17 / +23 / +2,8 %, '
    '+0,13 R par trade). Rejetées : g_asia (perdante sur l’or réel), n_pdlbrk (négative sur la séance seule de New York), toutes les stratégies '
    'Nasdaq de nuit.', body)]))

story.append(KeepTogether([Paragraph('Lucid : break-even et journalières S&amp;P 500', h2), Paragraph(
    'Plutôt que d’empiler de nouvelles familles, on a amélioré ce que Lucid trade déjà (npm run lucid-research4) : stop remonté au prix d’entrée '
    '(« break-even ») après +0,3 / +0,5 R, filtres de jour (lundi, vendredi, veille large ou étroite, écart d’ouverture) et journalières sur d’autres '
    'micro-futures CME, ajoutés un à un. Retenus : <b>Dow en break-even</b> (n_mom10_t1be : objectif 1 R, stop au prix d’entrée après +0,5 R) et '
    '<b>journalières propres à Lucid</b> : ' + esc(', '.join(f'{x.split(":")[1]} ({ {"spx": "S&P 500", "nas100": "Nasdaq", "russell": "Russell 2000", "silver": "argent", "dow": "Dow"}.get(x.split(":")[0], x.split(":")[0]) })' for x in fc['lds'])) + '. Les filtres font monter la réussite '
    'récente mais divisent les trades par deux (évaluation en 50 à 64 jours au lieu de 34) : non retenus.', body), Spacer(1, 3), small_table([
    ('Lucid, réussite < 1 an', '2009–2019', '2020–2026', 'nov. 24–26'),
    ('Avant', '55 % (85 j)', '72 % (110 j)', '94 % (34 j)'),
    ('+ break-even Dow + Double 7 / RSI 2 S&amp;P (avec micro-euro)', '56 % (74 j)', '76 % (85 j)', '100 % (37 j)'),
    ('Sans micro-euro (contrat 6E réel)', '45 % (87 j)', '46 % (131 j)', '76 % (44 j)'),
    ('<b>+ plus bas 10 j Russell, Double 7 Nasdaq / argent</b>', '<b>50 % (79 j)</b>', '<b>62 % (142 j)</b>', '<b>78 % (41 j)</b>'),
    ], [72 * mm, 34 * mm, 34 * mm, 40 * mm]), Spacer(1, 2), Paragraph(
    '<b>Correction (26/11/2026)</b> : la liste officielle des produits Lucid n’a <b>pas de micro-devises</b> (ni M6E, ni M6B) ; l’euro ne se trade '
    'qu’en 6E standard (125 000 €, ≈ 137 000 $ le contrat), trop gros pour la perte max de 2 000 $. L’IBS EUR/USD, gros contributeur de Lucid dans '
    'les calculs précédents, ne passe donc jamais : la réussite réelle était plus basse. Elle est remplacée par trois journalières sur des micros '
    'que Lucid propose (Russell M2K, Nasdaq MNQ, argent SIL).', body)]))

story.append(KeepTogether([Paragraph('Autres marchés pour Lucid (contrats CME)', h2), Paragraph(
    'Lucid ne propose que 34 contrats des bourses de Chicago et New York (CME, CBOT, NYMEX, COMEX) : <b>pas de CAC 40, de DAX ni d’indice '
    'européen</b>, pas de micro-devises, pas de taux, pas de crypto. Testés (npm run lucid-markets, intraday 2 ans + journalier depuis 2000, '
    'taille réelle des contrats et frais Lucid) : cuivre, platine, gaz naturel, maïs, soja, blé, huile et tourteau de soja, bovins, porcs, et les '
    'devises en contrat standard (dollar australien, livre, dollar canadien, euro, yen, franc suisse, dollar néo-zélandais). Nikkei : 280 000 $ '
    'le contrat, trop gros.', body), Spacer(1, 3), small_table([
    ('Lucid, risque de l’évaluation', '2009–2019', '2020–2026', 'nov. 24–26 (≤ 14 j)'),
    ('Actuel (avant correction de l’euro)', '45 %', '46 %', '39 % (20 %)'),
    ('+ soja ou platine intraday', '45 %', '46 %', '43 % (20 %)'),
    ('+ devises standard intraday (6A, 6B, 6E, 6J)', '45 %', '46 %', '29–37 % ✘'),
    ('+ maïs, gaz naturel intraday', '45 %', '46 %', '41–43 % (16–19 %) ✘'),
    ('+ journalières cuivre, gaz, soja', '—', '—', 'contrats trop gros : jamais pris'),
    ], [72 * mm, 30 * mm, 30 * mm, 48 * mm]), Spacer(1, 2), Paragraph(
    'Les contrats standard (25 000 à 150 000 $) sont trop gros pour une perte max de 2 000 $ : le gain reste marginal (soja, platine : +4 points '
    'sur 2 ans seulement, rien sur les 2 semaines) ; non ajoutés. Ce qui marche sur Lucid reste les micros (Nasdaq, S&amp;P, Dow, Russell, argent).', body)]))

story.append(KeepTogether([Paragraph('Objectif : réussir en 2 semaines', h2), Paragraph(
    'Départ chaque jour ouvré (nov. 2024 → nov. 2026), selon le risque (npm run twoweeks). À risque normal, ≈ 1 % des évaluations réussissent en 2 '
    'semaines, FTMO comme Lucid : l’avantage par trade est petit, il faut du temps. FTMO plafonne à 3–5 % en ≤ 14 jours même à risque × 4 (et 56 % '
    f'd’échecs) : inchangé. <b>Lucid</b> : risque intraday × {fr(fc["lem"])} <b>pendant l’évaluation</b> ({fr(fc["lir"] * fc["lem"])} % au lieu de {fr(fc["lir"])} %), '
    f'retour à {fr(fc["lir"])} % une fois le compte financé.', body), Spacer(1, 3), small_table([
    ('Lucid, risque intraday', 'Réussie ≤ 14 j', 'Réussie ≤ 30 j', 'Échouée ≤ 14 j', 'Évaluations / compte financé'),
    ('0,45 % (× 1)', '1 %', '17 %', '1 %', '1,3'),
    ('0,9 % (× 2)', '17 %', '44 %', '26 %', '1,9'),
    ('1,35 % (× 3)', '20 %', '34 %', '51 %', '≈ 2,6'),
    ('2,25 % (× 5)', '17 %', '25 %', '68 %', '3,4'),
    ], [46 * mm, 30 * mm, 30 * mm, 32 * mm, 42 * mm]), Spacer(1, 2), Paragraph(
    'Environ une évaluation sur cinq réussit en 2 semaines, mais une sur deux échoue dans le même temps : compter 2 à 3 évaluations achetées par '
    'compte financé. Chiffres sur 2 ans de données intraday seulement.', body), Spacer(1, 4), Paragraph(
    '<b>Gestion de la journée</b> (npm run lucid-research5, Lucid pendant l’évaluation) : on arrête de trader pour la journée dès que le gain du jour '
    'atteint <b>25 % de l’objectif (750 $)</b> — la règle du meilleur jour (≤ 40 %) ne bloque plus la réussite — ou <b>après le 1er trade perdant</b>. '
    'Testés sans gain : limite de perte du jour −0,5 / −1,5 / −2 %, arrêt après 2 ou 3 pertes, 1 à 3 positions au plus (plus lent). Nouveaux '
    'signaux testés et rejetés : filtre de tendance 20 jours, sortie partielle, « gap and go » (perdant partout), fin / début de mois.', body),
    Spacer(1, 3), small_table([
    ('Lucid, risque intraday × 3', 'Réussie ≤ 14 j', 'Réussie ≤ 30 j', 'Échouée ≤ 14 j', 'Évaluations / compte financé'),
    ('Sans gestion de la journée', '20 %', '34 %', '51 %', '2,6'),
    ('<b>Stop à +750 $ ou après 1 perte (actuel)</b>', '<b>25 %</b>', '<b>42 %</b>', '<b>47 %</b>', '<b>2,2</b>'),
    ], [56 * mm, 28 * mm, 28 * mm, 30 * mm, 38 * mm])]))

story.append(KeepTogether([Paragraph('Stop suiveur du compte FTMO', h2), Paragraph(
    'Testé sur toutes les stratégies du compte FTMO (npm run ftmo-tsl) : point mort à +1 R, suiveur 1 R après +1 / +1,5 / +2 R, suiveur '
    '0,5 R, Chandelier 3 / 4 ATR, sur l’intraday, les journalières ou tout. Retenu : <b>dès que le trade a fait +2 R, le stop suit à 1 R du '
    'meilleur cours</b> (clôtures de bougie), sur toutes les stratégies ; il ne recule jamais. Les réglages plus serrés coupent les gros gains '
    'qui font réussir le challenge. Lucid n’est pas concerné.', body), Spacer(1, 3), small_table([
    ('FTMO, réussite < 1 an', '2009–2019', '2020–2026', 'nov. 24–26'),
    ('Sans stop suiveur', '50 % (67 j)', '51 % (76 j)', '67 % (55 j)'),
    ('Point mort à +1 R', '55 %', '64 %', '59 % ✘'),
    ('Chandelier 3 ATR', '54 %', '64 %', '39 % ✘'),
    ('<b>Dès +2 R, stop à 1 R (actuel)</b>', '<b>55 % (80 j)</b>', '<b>57 % (76 j)</b>', '<b>73 % (76 j)</b>'),
    ], [72 * mm, 34 * mm, 34 * mm, 40 * mm]), Spacer(1, 3), Paragraph(
    '<b>Lucid, 6e recherche</b> (npm run lucid-research6, avec le réglage actuel) : l’intraday or (MGC) n’est stable sur 2009–2026 dans aucune '
    'version ; pétrole, Dow, argent neutres ou négatifs ; Russell rien. Ajouté : momentum de fin de journée sur le S&amp;P en break-even (MES) : '
    'nov. 24–26 51 → 53 %.', body)]))

story.append(KeepTogether([Paragraph('Order flow (delta, absorption, divergences)', h2), Paragraph(
    'Vrai order flow gratuit : volume des acheteurs et vendeurs agressifs de Binance, minute par minute, Bitcoin et Ethereum 2020 → 2026 '
    '(3,6 millions de bougies chacun), plus un delta approximé sur le Nasdaq et le S&amp;P (2 ans). Avant frais, le delta contient un peu '
    'd’information à 1 minute ; après frais, tout perd, partout : 0,04 % de frais valent ≈ 0,4 R sur une bougie de 1 minute. Rien d’ajouté.', body),
    Spacer(1, 3), small_table([
    ('Bitcoin 1 min, vrai delta (R moyen par trade)', 'Avant frais', 'Après frais 0,04 %'),
    ('Absorption', '+0,09 R', '−0,49 R'),
    ('Divergence du delta cumulé', '+0,04 R', '−0,76 R'),
    ('Épuisement', '+0,05 R', '−0,88 R'),
    ('Témoin « prix seul »', '0,00 R', '−0,77 R'),
    ], [90 * mm, 44 * mm, 44 * mm])]))
story.append(KeepTogether([Paragraph('ICT (FVG, Silver Bullet, liquidité, SMT, order blocks)', h2), Paragraph(
    'Règles ICT écrites précisément et testées frais compris : Nasdaq et S&amp;P en 1 et 5 minutes (2 ans), or en 5 minutes (2009 → 2026). '
    'Une seule règle passe : un <b>FVG en 5 minutes dans le sens de la veille</b> (≈ +0,1 R par trade sur le Nasdaq et le S&amp;P, positif sur '
    'les 3 périodes), mais elle échoue en 1 et 15 minutes et ≈ 0 sur l’or en 17 ans : à confirmer sur un historique plus long, non ajoutée.', body),
    Spacer(1, 3), small_table([
    ('R moyen par trade, frais compris', 'Nasdaq', 'S&amp;P 500', 'Or 2009–26'),
    ('Silver Bullet 10 h – 11 h', '−0,15', '−0,11', '−0,06'),
    ('Balayage du plus haut / bas de la veille', '−0,22', '−0,24', '−0,17'),
    ('SMT (divergence Nasdaq / S&amp;P)', '−0,31', '−0,39', '—'),
    ('Order block', '−0,27', '−0,38', '−0,19'),
    ('FVG 5 min dans le sens de la veille', '+0,11', '+0,09', '+0,01'),
    ('Témoin : entrées au hasard', '−0,17', '−0,27', '−0,14'),
    ], [86 * mm, 30 * mm, 30 * mm, 32 * mm])]))

story += part(4, 'Le bot au quotidien')
story.append(KeepTogether([Paragraph('Exécution, notifications et outils', h2), Paragraph(
    f'<b>Exécution « comme en vrai »</b> : les comptes FTMO et Lucid entrent et sortent (sur signal) au cours {fc["fd"]:g} s après le signal ; stops et '
    'objectifs restent au niveau. Un cours relevé plus ancien que les données du signal (Yahoo : bougies 1 min et 5 min pas au même retard) '
    'est ignoré : le compte garde alors le prix du signal. <b>Notifications</b> : chaque achat / vente des comptes est annoncé dans le groupe Telegram, avec une copie en privé '
    'si le groupe ne le reçoit pas. <b>Time Machine</b> (/timemachine) : chances de réussir le challenge en cours d’après 1 000 années simulées. '
    '<b>Comptes financés</b> : retraits simulés (FTMO tous les 14 jours, Lucid après 5 jours gagnants). <b>/reset</b> (admin) : comptes remis à zéro '
    '(nouveau challenge au capital de départ), historique, trades archivés et stats gardés. <b>Boucle de test</b> (npm run selftest) : '
    'tout le bot rejoué hors ligne (commandes, boutons, messages, cycle complet des comptes).', body)]))

story.append(KeepTogether([Paragraph('Suivi en direct', h2), Paragraph(
    'Onglet <b>« Bot »</b> du site marches-eight.vercel.app, en style terminal : comptes FTMO, Lucid et portefeuille perso (solde, objectif, '
    'limites), marchés suivis, positions et historique des trades en vert / rouge. Graphique <b>« Trades du bot »</b> au style TradingView, '
    'bougies de 1 minute à 1 jour, zoom automatique sur la position : chaque trade y est dessiné comme l’outil position de TradingView '
    '(zone rouge = risque jusqu’au stop, zone verte = objectif, pointillé jusqu’à la sortie). Bouton <b>TradingView</b> : le vrai graphique '
    'TradingView (après accord pour ses traceurs). Bouton <b>Pine</b> : script à coller dans TradingView pour voir les trades du bot sur ton '
    'propre graphique. <b>Telegram</b> : chaque trade, chaque trade bloqué par l’IA et son bilan, /pnl (PnL du jour), /ftmo, /lucid, '
    '/portefeuille, /interface, /export. Mise à jour toutes les 15 s environ.', body)]))
story.append(KeepTogether([Paragraph('Portefeuille perso, sans prop firm', h2), Paragraph(
    'Pour son propre argent, sur le long terme : ETF réels, dividendes inclus, sans levier, frais 0,1 %, rééquilibrage mensuel, en euros, '
    'décembre 2004 → novembre 2026. Retenu : <b>50 % monde, 10 % or, 40 % confiés à cinq stratégies journalières du bot</b> (RSI 2 et Double 7 sur '
    'le S&amp;P 500, croix dorée sur le Nasdaq 100, tendance et saison sur l’or), simulé en direct dans le bot (/portefeuille, 10 000 €).', body),
    Spacer(1, 3), small_table([
    ('Portefeuille (en euros)', 'Par an', 'Pire baisse', 'Pire année', '300 €/mois depuis 2005'),
    ('Monde (60 % S&amp;P 500 + 40 % hors USA)', '9,8 %', '−53 %', '−36 %', '320 000 €'),
    ('S&amp;P 500', '11,5 %', '−51 %', '−34 %', '438 000 €'),
    ('Nasdaq 100', '15,3 %', '−47 %', '−39 %', '791 000 €'),
    ('<b>Cœur + bot : 50 % monde, 10 % or, 40 % bot (actuel)</b>', '<b>10,2 %</b>', '<b>−26 %</b>', '<b>−14 %</b>', '<b>299 000 €</b>'),
    ('Bot seul (5 stratégies)', '9,3 %', '−16 %', '−2 %', '252 000 €'),
    ], [72 * mm, 22 * mm, 26 * mm, 26 * mm, 32 * mm]), Paragraph(
    'Versé au total : 79 200 €. Le Nasdaq a eu 20 ans exceptionnels (biais du rétroviseur). Une part de 10 % de Bitcoin avec règle de tendance '
    '(au-dessus de sa moyenne 200 jours, sinon liquidités) a amélioré le rendement sans augmenter la pire baisse, même en partant du sommet de 2021 ; '
    'non ajoutée.', note)]))

# Guide « trader sans le bot » (exemples réels : node scripts/guide-examples.js > docs/guide-examples.json)
_gx = os.path.join(ROOT, 'docs', 'guide-examples.json')
if os.path.exists(_gx):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import guide_pdf
    story += guide_pdf.build({'W': W, 'title': title, 'h2': h2, 'body': body, 'cell': cell, 'cellb': cellb, 'head': head, 'INK': INK, 'LINE': LINE,
                              'part': part, 'tstyle': tstyle, 'SOFT': SOFT, 'ZEBRA': ZEBRA, 'note': note},
                             json.load(open(_gx, encoding='utf-8')), fc)

story += part(6, soft=True, name='Historiques simulés', intro='Chaque stratégie part de 1 000 $, gains réinvestis, frais inclus. Légende et rendement annuel dans chaque image ; '
              'pointillé gris : garder le marché.')
for img, cap in [('historique-or-2001.png', 'Or, 2001 → 2026 (future GC=F)'), ('historique-nasdaq-2010.png', 'Nasdaq 100, 2010 → 2026 (financement CFD 6 %/an inclus)')]:
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
