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
    style = [('BACKGROUND', (0, 0), (-1, 0), INK), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEBELOW', (0, 1), (-1, -1), 0.4, LINE),
             ('TOPPADDING', (0, 0), (-1, -1), 3.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5), ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4)]
    for r, s in enumerate(rows, start=1):
        st = status(s)
        label, bg = STATUS[st]
        if 'spx' in s['active']:
            label += ' + S&amp;P 500'
        if 'silver' in s['active']:
            label += ' + argent'
        if 'dow' in s['active']:
            label += ' + Dow'
        if 'eurusd' in s['active']:
            label += ' + EUR/USD (essai)' if st != 'ESSAI' else ' (EUR/USD)'
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
n_eur = sum('eurusd' in s['active'] for s in strats)
n_spx = sum('spx' in s['active'] for s in strats)
n_sil = sum('silver' in s['active'] for s in strats)
n_dow = sum('dow' in s['active'] for s in strats)
n_dispo = sum(status(s) == 'DISPO' for s in strats)
n_rej = sum(status(s) == 'REJ' for s in strats)
months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
d = datetime.date.today()

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=17 * mm,
                        title='Stratégies du bot de paper trading', author='Gold Paper Bot')
story = [Paragraph('Stratégies du bot de paper trading', title),
         Paragraph(f'Or (future GC=F), Nasdaq 100 (^NDX), S&amp;P 500 (^GSPC), EUR/USD, argent (SI=F) et Dow Jones (^DJI) · état au {d.day} {months[d.month - 1]} {d.year}', sub), Spacer(1, 8)]
summary = [
    (len(strats), 'stratégies codées et testées (+ la référence « garder le marché »)'),
    (len(active), f'actives en direct : {n_gold} sur l’or, {n_nas} sur le Nasdaq, {n_spx} sur le S&amp;P 500, {n_eur} sur l’EUR/USD, {n_sil} sur l’argent, {n_dow} sur le Dow Jones (certaines sur plusieurs marchés)'),
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
    'Scalp or : les scalps choisis sur PAXG (jeton or de Binance, 2020–2026) perdent sur l’or au comptant réel (HistData 2009–2026) : leur avantage venait de la cotation de PAXG. Ils ne sont plus suivis par le compte FTMO. Rien n’est validé en scalp sur le Nasdaq.',
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
fc = json.loads(subprocess.run(['node', '-e', "const c=require('./src/config');console.log(JSON.stringify({aa:c.autoAdapt,as:c.adaptStrategies,g:c.ftmoStrategies,gr:c.ftmoRisk,ir:c.ftmoIntradayRisk,n:c.ftmoNasStrategies,nr:c.ftmoNasRisk,ds:c.ftmoDayStop,cb:c.ftmoCombined,cnr:c.ftmoComboNasRisk,prog:c.ftmoProgram,sz:c.ftmoSizing,ai:c.ftmoAi,lu:c.lucidEnabled,lc:c.lucidCapital,lir:c.lucidIntradayRisk,lis:c.lucidIntradayStrategies,lm:c.lucidRiskMul,lcons:c.lucidConsistency,fd:c.fillDelaySec}))"],
                               cwd=ROOT, capture_output=True, text=True, check=True).stdout)
ids = lambda l: ', '.join(x.split(':', 1)[-1] for x in l)
story.append(PageBreak())
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
                             'divisée par 2 avec 2 positions ouvertes) : <b>50 %</b> (2009–2019), <b>51 %</b> (2020–2026), <b>67 %</b> (nov. 2024 → '
                             'nov. 2026, intraday compris), en ≈ 55 j médians sur la période récente ; chances du challenge en cours : /timemachine.')
                            if fc['prog'] == '1step' else
                            ('sept. 2020 → oct. 2024 : <b>97 % en moins de 6 mois</b> (46 j en médiane) ; 2 dernières années (vérification) : <b>46 %</b> (34 j). '
                             'Les scalps or rapportent moins depuis 2024.'), cell)]]
t = Table(ft, colWidths=[30 * mm, 62 * mm, 20 * mm, 68 * mm], repeatRows=1)
t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), INK), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEBELOW', (0, 1), (-1, -1), 0.4, LINE),
                       ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
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
    t = Table([[Paragraph(x, head) for x in rows[0]]] + [[Paragraph(x, cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), INK), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LINEBELOW', (0, 1), (-1, -1), 0.4, LINE),
                           ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
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
    'Pour chaque signal du compte, un modèle entraîné sur ≈ 13 000 trades passés (régression logistique) estime la chance que le trade soit gagnant, '
    'avec ce qui est connu à l’entrée : forme récente de la stratégie et du marché, distance du stop, heure, jour, tendance, élan et volatilité du marché, VIX. '
    + ('<b>En direct, les signaux sous le seuil (≈ 20 % des signaux) ne sont pas pris</b> (« signal refusé par l’IA ») ; chaque refus est gardé et '
       'son trade paper dit ce qu’il aurait fait (bilan dans /ftmo).' if fc['ai'] == 'block' else 'En direct, l’IA donne seulement son avis sur chaque trade.'), body))
story += [Spacer(1, 3), small_table([
    ('Test (modèle entraîné sans voir la période)', 'Sans IA', 'IA, 20 % refusés'),
    ('2020–2026 (entraîné sur 2009–2019)', '46 %', '<b>55 %</b>'),
    ('nov. 2024 → nov. 2026', '44 %', '<b>88 %</b>'),
    ('2017–2019 (entraîné sur 2009–2016)', '50 %', '42 % ✘'),
    ('Année par année, 2012–2026', '—', 'garde les meilleurs trades <b>10 années sur 15</b>'),
], [80 * mm, 30 * mm, 70 * mm]), Spacer(1, 2), Paragraph(
    'Résultat encourageant mais pas garanti : l’IA s’est trompée plusieurs années de suite (2017–2019). Le bilan des signaux refusés en direct dira si elle aide.', body)]

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
    + (f'<b>En direct</b>, un compte <b>LucidFlex {fc["lc"] // 1000}K</b> simulé (/lucid), en micro-contrats entiers (MGC, MNQ, MES, M6E, SIL, MYM), '
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
    ('<b>FTMO (actuel)</b>', f'idem, risque × 1,25, + Crabel NR7 S&amp;P 500', '<b>50 %</b>', '<b>51 %</b>', '<b>67 %</b> (55 j)'),
    ('Lucid (avant)', 'idem FTMO', '13 %', '11 %', '21 %'),
    ('Lucid (24/11)', f'journalières {fc["gr"] * fc["lm"]:g} % · Nasdaq intraday {fc["lir"]:g} %, objectif 0,5 R', '56 %', '69 %', '100 % (≈ 70 j)'),
    ('<b>Lucid (actuel)</b>', '+ cassures, Crabel, Williams, argent, Dow (≈ 4,7 trades intraday / jour)', '<b>55 %</b>', '<b>72 %</b>', '<b>94 %</b> (34 j)'),
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

story.append(KeepTogether([Paragraph('Séances d’Asie et de New York', h2), Paragraph(
    '92 variantes testées sur l’or au comptant réel 2009–2026 et le Nasdaq (2 ans) : cassures d’ouverture (Tokyo, Shanghai, COMEX, New York), '
    'fixing de Londres, clôture de Londres, dernière heure, nuit asiatique, écarts d’ouverture, plus haut / plus bas de la veille, pré-ouverture, '
    'Nasdaq la nuit (future NQ=F). Retenues sur le compte FTMO : <b>g_asiabrk</b> (cassure du range de la nuit asiatique à l’ouverture de Londres : '
    '+20 / +13 / +16 % sur 3 tranches) et <b>g_nypdl</b> (cassure du plus haut / plus bas de la veille sur l’or pendant New York : +17 / +23 / +2,8 %, '
    '+0,13 R par trade). Rejetées : g_asia (perdante sur l’or réel), n_pdlbrk (négative sur la séance seule de New York), toutes les stratégies '
    'Nasdaq de nuit.', body)]))

story.append(KeepTogether([Paragraph('Exécution, notifications et outils', h2), Paragraph(
    f'<b>Exécution « comme en vrai »</b> : les comptes FTMO et Lucid entrent et sortent (sur signal) au cours {fc["fd"]:g} s après le signal ; stops et '
    'objectifs restent au niveau. <b>Notifications</b> : chaque achat / vente des comptes est annoncé dans le groupe Telegram, avec une copie en privé '
    'si le groupe ne le reçoit pas. <b>Time Machine</b> (/timemachine) : chances de réussir le challenge en cours d’après 1 000 années simulées. '
    '<b>Comptes financés</b> : retraits simulés (FTMO tous les 14 jours, Lucid après 5 jours gagnants). <b>Boucle de test</b> (npm run selftest) : '
    'tout le bot rejoué hors ligne (commandes, boutons, messages, cycle complet des comptes).', body)]))

story.append(KeepTogether([Paragraph('Suivi en direct', h2), Paragraph(
    'Catégorie <b>« Bot »</b> du site marches-eight.vercel.app : comptes FTMO et Lucid simulés (valeur, objectif, perte du jour et perte max avec leur '
    'seuil), graphique TradingView (Lightweight Charts) avec l’entrée, le stop loss et l’objectif de chaque position ouverte et les repères des trades, '
    'historique complet (challenge en cours, anciens challenges, trades de chaque stratégie). Mise à jour toutes les 15 s environ. Telegram : '
    'messages de chaque trade du compte FTMO, /ftmo, /lucid, /interface, /export. Le stop est vérifié au cours actuel avant toute sortie programmée '
    '(sortie au niveau du stop, comme un vrai ordre).', body)]))

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
