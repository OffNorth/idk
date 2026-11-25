"""
Guide « trader les stratégies sans le bot » du PDF (appelé par scripts/make-pdf.py) : bases (risque, taille, heures de
Paris), une fiche par famille de stratégies actives avec ses règles exactes et un exemple réel (dernier trade gagnant
sur les données Yahoo, docs/guide-examples.json, régénéré par `node scripts/guide-examples.js`), graphique en bougies.
"""
import datetime
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle, KeepTogether, PageBreak
from reportlab.graphics.shapes import Drawing, Rect, Line, String, Circle

UP, DOWN, ENTRY, STOP, TARGET, LEVEL = (colors.HexColor(c) for c in ('#16a34a', '#dc2626', '#2563eb', '#dc2626', '#16a34a', '#9ca3af'))


def fr(v, d=2):
    s = f'{v:,.{d}f}'.replace(',', ' ').replace('.', ',')
    return s


def chart(ex, width=180 * mm, height=62 * mm):
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
    hline(ex['entry'], ENTRY, f'entrée {fr(ex["entry"])}')
    hline(ex['sl'], STOP, f'stop {fr(ex["sl"])}')
    if ex.get('tp'):
        hline(ex['tp'], TARGET, f'objectif {fr(ex["tp"])}')
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
        lab = c[i].get('hm') or datetime.datetime.fromtimestamp(c[i]['t'], datetime.timezone.utc).strftime('%d/%m')
        d.add(String(x(i) - 6, 3, lab, fontName='DV', fontSize=5.5, fillColor=colors.HexColor('#6b7280')))
    return d


def build(S, ex, fc):
    """S : styles (title, h2, body, cell, cellb, head, INK, LINE) ; ex : exemples ; fc : réglages du bot."""
    body, h2, cell, cellb, head = S['body'], S['h2'], S['cell'], S['cellb'], S['head']
    h3 = ParagraphStyle('h3', parent=body, fontName='DVB', fontSize=10.5, leading=14, spaceBefore=6, spaceAfter=3, textColor=S['INK'])
    box = ParagraphStyle('box', parent=body, backColor=colors.HexColor('#f3f4f6'), borderPadding=5, spaceBefore=4, spaceAfter=6)
    out = []

    def table(rows, widths):
        t = Table([[Paragraph(x, head) for x in rows[0]]] + [[Paragraph(x, cell) for x in r] for r in rows[1:]], colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), S['INK']), ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEBELOW', (0, 1), (-1, -1), 0.4, S['LINE']),
                               ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
        return t

    def rules(rows):
        t = Table([[Paragraph(f'<b>{a}</b>', cell), Paragraph(b, cell)] for a, b in rows], colWidths=[30 * mm, 150 * mm])
        t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEBELOW', (0, 0), (-1, -1), 0.4, S['LINE']), ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f9fafb')),
                               ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
        return t

    def example(key, unit, point_usd_lucid, contract, extra=''):
        e = ex.get(key) or {}
        if not e or e.get('error'):
            return [Paragraph('<i>Exemple indisponible (données).</i>', body)]
        sens = 'achat' if e['side'] == 'long' else 'vente'
        risk = abs(e['entry'] - e['sl'])
        when = f'{e["day"]}, entrée à {e["entryTime"]} (heure de Paris), sortie à {e["exitTime"]}' if e.get('day') else f'entrée le {e["entryDay"]} à la clôture, sortie le {e["exitDay"]}'
        why = {'take profit': 'objectif atteint', 'stop loss': 'stop touché', 'signal de sortie': 'sortie prévue par la règle'}.get(e['reason'], e['reason'])
        daily = not e.get('day')
        lucid_risk = 50_000 * (fc['gr'] * fc['lm'] if daily else fc['lir'] * fc['lem']) / 100
        one = risk * point_usd_lucid
        n = int(lucid_risk // one) if one > 0 else 0
        if n < 1 and 0 < one <= min(1.5 * lucid_risk, 800):
            n = 1  # 1 contrat quand même si son risque reste raisonnable (règle du bot)
        size = (f'Taille sur Lucid 50K (risque {fr(fc["gr"] * fc["lm"]) if daily else fr(fc["lir"] * fc["lem"])} % = {fr(lucid_risk, 0)} $'
                f'{"" if daily else " pendant l’évaluation"}) : 1 {contract} risque '
                f'{fr(risk, 2)} × {fr(point_usd_lucid, 0)} $ = {fr(one, 0)} $ → {fr(lucid_risk, 0)} ÷ {fr(one, 0)} = <b>{n} contrat(s)</b>'
                + (f', résultat {"+" if e["r"] >= 0 else ""}{fr(n * (e["exit"] - e["entry"]) * (1 if e["side"] == "long" else -1) * point_usd_lucid, 0)} $' if n >= 1 else ' (trop gros : trade non pris)') + '.') if point_usd_lucid else ''
        txt = (f'<b>Exemple réel</b> ({e["sym"]}) : {when}. <b>{sens.capitalize()}</b> à {fr(e["entry"])}, stop {fr(e["sl"])} '
               f'(risque {fr(risk)} {unit} = 1 R)' + (f', objectif {fr(e["tp"])}' if e.get('tp') else '') + f'. Sortie à {fr(e["exit"])} ({why}) : '
               f'<b>{"+" if e["r"] >= 0 else ""}{fr(e["r"])} R</b>. {size} {extra}'
               f'<br/><font color="#6b7280">Sur les données récentes (depuis le {e["since"]}) : {e["n"]} trades, {fr(e["win"], 0)} % gagnants, '
               f'{"+" if e["avgR"] >= 0 else ""}{fr(e["avgR"])} R en moyenne par trade — des pertes arrivent souvent, l’avantage est dans la répétition.</font>')
        return [chart(e), Spacer(1, 2), Paragraph(txt, body)]

    # ---------------------------------------------------------------------------------------------------------------
    out += [PageBreak(), Paragraph('Guide : trader les stratégies à la main', S['title']), Paragraph(
        'Ce guide explique, sans jargon, comment reproduire toi-même les stratégies qui marchent dans le bot, avec leurs règles exactes et un '
        'exemple réel tiré des données récentes. Tout est en <b>heure de Paris</b>. Règle d’or : décider AVANT d’entrer où est le stop, où est '
        'l’objectif et combien on risque — et ne jamais déplacer le stop pour « laisser une chance » au trade.', body)]

    out += [Paragraph('1. Les bases', h2), Paragraph(
        '<b>Le « R »</b> : c’est le risque d’un trade, la distance entre ton prix d’entrée et ton stop. Un trade qui gagne 2 fois cette distance '
        'fait +2 R ; un stop touché fait −1 R. On compte en R pour comparer des trades de tailles différentes.', body), Spacer(1, 3), Paragraph(
        '<b>La taille de la position</b> se calcule à partir du risque, jamais au hasard :<br/>'
        '<b>nombre de contrats = risque en $ ÷ (distance au stop en points × valeur d’un point)</b>, arrondi vers le bas.<br/>'
        'Si le résultat est 0 : on prend 1 contrat seulement s’il risque au plus 1,5 × le risque prévu (et au plus 800 $ chez Lucid) ; '
        'sinon le stop est trop loin pour ce compte, <b>on passe son tour</b>.', box), Paragraph(
        f'Risque par trade utilisé par le bot : <b>Lucid</b> intraday {fr(fc["lir"] * fc["lem"])} % pendant l’évaluation ({fr(fc["lir"])} % une fois financé), '
        f'journalier {fr(fc["gr"] * fc["lm"])} % ; <b>FTMO</b> intraday {fr(fc["ir"] * 1.25, 3)} %, journalier ≈ {fr(fc["gr"] * 1.25)} %.', body), Spacer(1, 3),
        table([('Contrat (Lucid)', 'Valeur d’un point', 'Exemple : stop à 100 points'),
               ('MNQ (micro Nasdaq)', '2 $ par point', '1 contrat = 200 $ de risque'),
               ('MES (micro S&amp;P 500)', '5 $ par point', '1 contrat = 500 $'),
               ('MYM (micro Dow)', '0,50 $ par point', '1 contrat = 50 $'),
               ('MGC (micro or)', '10 $ par dollar d’or', 'stop à 10 $ → 100 $'),
               ('SIL (micro argent)', '1 000 $ par dollar d’argent', 'stop à 0,20 $ → 200 $'),
               ('FTMO XAUUSD (or)', '1 lot = 100 onces = 100 $ par dollar', 'stop à 10 $ → 1 000 $ par lot (0,1 lot = 100 $)')],
              [50 * mm, 55 * mm, 75 * mm]), Spacer(1, 3), Paragraph(
        '<b>Heures de Paris</b> : la séance de New York (Nasdaq, S&amp;P, Dow, argent) ouvre à <b>15 h 30</b> et ferme à <b>22 h</b>. Attention : '
        'quelques semaines par an (mi-mars → fin mars, fin octobre → début novembre), les États-Unis changent d’heure avant l’Europe : la '
        'séance ouvre alors à 14 h 30. L’or « de Londres » se lit en heure UTC : 7 h UTC = 8 h à Paris en hiver, 9 h en été.', body), Spacer(1, 3), Paragraph(
        '<b>Les règles du compte</b> : Lucid 50K = +3 000 $ (6 %) pour réussir, perte max 2 000 $ sous le plus haut solde de fin de journée, et '
        'ton meilleur jour ne doit pas dépasser 40 % du gain total (il faut donc au moins 3 jours gagnants). FTMO 100K = +10 %, perte du jour 3 %, '
        'perte max 10 % depuis le plus haut, meilleur jour ≤ 50 % du gain.', body)]

    # ---------------------------------------------------------------------------------------------------------------
    out += [PageBreak(), Paragraph('2. Cassure de l’ouverture (Nasdaq)', h2), Paragraph(
        '<b>L’idée</b> : les premières minutes de la séance fixent une fourchette (le « range d’ouverture »). Quand le prix en sort franchement, '
        'il continue souvent dans ce sens pendant un moment. On entre à la sortie du range, le stop de l’autre côté.', body), Spacer(1, 3), rules([
        ('Marché', 'Nasdaq 100 (MNQ chez Lucid, US100 / NAS100 chez FTMO), séance de New York seulement.'),
        ('Préparation', '15 h 30 → 16 h : noter le plus haut et le plus bas des 30 premières minutes (version 30 min). Graphique en bougies de 5 min.'),
        ('Entrée', 'Première bougie de 5 min qui <b>clôture au-dessus</b> du plus haut du range, avant 18 h → <b>achat</b> à la clôture de cette bougie. '
                   '(Version Lucid « à la hausse » : on ne prend que les cassures vers le haut.)'),
        ('Stop', 'Au plus bas du range (de l’autre côté).'),
        ('Objectif', 'Lucid : 0,75 R (0,75 × la distance entrée → stop). FTMO : pas d’objectif, on laisse courir.'),
        ('Sortie', 'Objectif ou stop touché ; sinon on ferme à 21 h 55, avant la clôture.'),
        ('Variantes', 'range de 10 min (même chose, objectif 0,75 R) · 1re heure 15 h 30 → 16 h 30 dans les deux sens (objectif 0,5 R, entrée avant 21 h) · '
                      'FTMO : 15 min si la séance a ouvert au-dessus de la clôture de la veille ; vente sous le plus bas des 5 premières minutes.'),
    ])] + example('orb', 'points', 2, 'MNQ')

    out += [PageBreak(), Paragraph('3. Crabel : la cassure après une journée calme', h2), Paragraph(
        '<b>L’idée</b> (Toby Crabel) : après une journée très étroite, le marché « se détend » et fait souvent un grand mouvement. On ne prend la '
        'cassure d’ouverture QUE ces jours-là, ce qui filtre beaucoup de faux départs.', body), Spacer(1, 3), rules([
        ('Marché', 'Nasdaq 100 (Lucid), S&amp;P 500 (FTMO, version NR7 30 min).'),
        ('Filtre du jour', '<b>NR4</b> : l’amplitude (plus haut − plus bas) de la séance d’hier est la plus petite des 4 dernières séances. '
                           '<b>NR7</b> : la plus petite des 7 dernières. Sinon : pas de trade aujourd’hui.'),
        ('Préparation', 'Range des 30 premières minutes (15 h 30 → 16 h) ; 15 minutes pour la version NR7 Lucid.'),
        ('Entrée', 'Première clôture 5 min au-dessus du range → achat ; en dessous → vente (avant 21 h).'),
        ('Stop', 'De l’autre côté du range.'),
        ('Objectif', 'Lucid : 0,5 R (NR4) ou 0,75 R (NR7). FTMO : pas d’objectif.'),
        ('Sortie', 'Objectif, stop, ou 21 h 55.'),
    ])] + example('crabel', 'points', 2, 'MNQ')

    out += [PageBreak(), Paragraph('4. Williams : la cassure de volatilité', h2), Paragraph(
        '<b>L’idée</b> (Larry Williams) : si le prix s’éloigne de l’ouverture de plus de la moitié de l’amplitude de la veille, un vrai mouvement '
        'est en cours. Le seuil s’adapte tout seul à la volatilité du moment.', body), Spacer(1, 3), rules([
        ('Marché', 'Nasdaq 100 (MNQ) et argent (SIL, séance de New York) — Lucid.'),
        ('Préparation', 'Amplitude de la veille = plus haut − plus bas de la séance d’hier (15 h 30 → 22 h). Seuils : ouverture ± 0,5 × amplitude '
                        '(version 0,7 : ± 0,7 × amplitude).'),
        ('Entrée', 'Première clôture 5 min au-dessus de « ouverture + 0,5 × amplitude » → achat ; sous « ouverture − 0,5 × amplitude » → vente.'),
        ('Stop', 'Au prix d’ouverture du jour.'),
        ('Objectif', '0,75 R (version 0,5) ; 0,5 R (version 0,7).'),
        ('Sortie', 'Objectif, stop, ou 21 h 55.'),
    ])] + example('williams', 'points', 2, 'MNQ')

    out += [PageBreak(), Paragraph('5. Le mouvement de la matinée donne la fin de journée', h2), Paragraph(
        '<b>L’idée</b> : quand le Nasdaq a déjà beaucoup bougé en début de séance, la dernière heure va souvent dans le même sens (les gros '
        'investisseurs finissent leurs ordres).', body), Spacer(1, 3), rules([
        ('Marché', 'Nasdaq 100 (MNQ) ; même règle sur le Dow (MYM, Lucid).'),
        ('Condition', 'À 16 h (10 h à New York), le cours a bougé de plus de 0,5 % depuis la clôture de la veille, dans un sens ou dans l’autre.'),
        ('Entrée', 'À <b>21 h</b> (15 h à New York), dans le sens du mouvement du matin.'),
        ('Stop', '3 ATR (3 × la taille moyenne d’une bougie de 5 min sur les 14 dernières ; l’indicateur « ATR 14 » de TradingView).'),
        ('Objectif', 'Nasdaq Lucid : 0,5 R. Dow Lucid : 1 R, et dès que le trade fait +0,5 R, <b>stop remonté au prix d’entrée</b> (il ne peut plus perdre).'),
        ('Sortie', 'Objectif, stop, ou 21 h 55.'),
    ])] + example('mom', 'points', 2, 'MNQ')

    out += [PageBreak(), Paragraph('6. Or : cassure de l’ouverture de Londres (FTMO)', h2), Paragraph(
        '<b>L’idée</b> : Londres est la place principale de l’or. Le range de la première demi-heure de Londres sert de rampe de lancement pour la journée.', body),
        Spacer(1, 3), rules([
        ('Marché', 'Or (XAUUSD chez FTMO). Pas sur Lucid (1 micro-contrat or est trop gros pour sa perte max).'),
        ('Préparation', 'Range de 7 h à 7 h 30 <b>UTC</b> (8 h → 8 h 30 à Paris en hiver, 9 h → 9 h 30 en été). Version 60 min : 7 h → 8 h UTC.'),
        ('Entrée', 'Première clôture 5 min au-dessus du range → achat ; en dessous → vente ; avant 9 h 30 UTC.'),
        ('Stop', 'De l’autre côté du range.'),
        ('Objectif', 'Aucun : on laisse courir jusqu’au soir (c’est ce qui fait les gros gains, avec seulement ≈ 25 % de trades gagnants).'),
        ('Sortie', 'Stop, ou 19 h 55 UTC (20 h 55 à Paris en hiver).'),
    ])] + example('londres', '$', 0, 'MGC', 'Taille FTMO : risque ≈ 0,19 % de 100 000 $ = 190 $ ; 1 lot XAUUSD = 100 $ par dollar.')

    out += [PageBreak(), Paragraph('7. Or : cassure du range de la nuit asiatique (FTMO)', h2), Paragraph(
        '<b>L’idée</b> : pendant la nuit (Tokyo, Hong Kong, Shanghai) l’or bouge peu. À l’arrivée de l’Europe, la sortie de ce range nocturne '
        'donne souvent la direction de la journée.', body), Spacer(1, 3), rules([
        ('Marché', 'Or (XAUUSD, FTMO).'),
        ('Préparation', 'Plus haut et plus bas de 0 h à 7 h UTC (1 h → 8 h à Paris en hiver).'),
        ('Entrée', 'Première clôture 5 min au-dessus → achat, en dessous → vente ; avant 11 h UTC.'),
        ('Stop', 'De l’autre côté du range de la nuit.'),
        ('Sortie', '19 h UTC (ou stop).'),
        ('Autres stratégies or (FTMO)', '<b>Plus haut / plus bas de la veille</b> : entre 8 h 20 et 12 h New York, clôture au-delà → on suit, stop 1,5 ATR, '
         'sortie 16 h 55 NY. <b>Écart d’ouverture</b> : l’or ouvre à 7 h UTC à plus de 0,3 % de la veille et continue après 15 min → on suit, stop '
         '2 ATR. <b>Matinée → après-midi</b> : à 8 h UTC, l’or a bougé de plus de 0,25 % depuis 20 h UTC la veille → on prend ce sens à 12 h 30 UTC, '
         'stop 3 ATR, sortie 19 h 55 UTC.'),
    ])] + example('asie', '$', 0, 'MGC', 'Taille FTMO : risque ≈ 190 $ ; stop de 68 $ → 190 ÷ (68 × 100) ≈ 0,03 lot.')

    out += [PageBreak(), Paragraph('8. Achats de replis en journalier', h2), Paragraph(
        '<b>L’idée</b> : dans un marché qui monte sur le long terme (au-dessus de sa moyenne 200 jours), une petite baisse de quelques jours est '
        'souvent rachetée. On achète la baisse à la clôture, on revend au rebond. Ces stratégies gagnent souvent (70–80 % des trades) mais un '
        'trade peut durer plusieurs jours : à garder la nuit.', body), Spacer(1, 3), rules([
        ('Filtre commun', 'Clôture du jour <b>au-dessus de la moyenne mobile 200 jours</b> (indicateur « SMA 200 » sur un graphique journalier). Sinon rien.'),
        ('RSI 2', 'Achat à la clôture quand le RSI sur 2 jours est sous 10 ; revente à la première clôture au-dessus de la moyenne 5 jours.'),
        ('Double 7', 'Achat quand le marché clôture à son plus bas des 7 derniers jours ; revente quand il clôture à son plus haut des 7 jours.'),
        ('3 baisses', 'Achat après 3 clôtures en baisse d’affilée ; revente à la première clôture en hausse.'),
        ('IBS', 'IBS = (clôture − plus bas) ÷ (plus haut − plus bas). Achat si IBS &lt; 0,2 ; revente si IBS &gt; 0,8 ou clôture au-dessus du plus haut de la veille.'),
        ('Autres', '<b>−5 % sous le plus haut de 20 jours</b> → achat, revente au retour sur ce plus haut · <b>plus bas de 10 jours</b> → achat, revente au '
                   'plus haut de 5 jours · <b>−2,5 % en une séance</b> ou <b>2 séances à −1 %</b> → achat, revente à la clôture au-dessus du plus haut de la veille.'),
        ('Stop', '3 ATR journaliers sous l’entrée (rarement touché, c’est une sécurité).'),
        ('Où', 'Lucid : S&amp;P 500 (MES : RSI 2, Double 7, 3 baisses), Nasdaq (MNQ). FTMO : or, S&amp;P, Nasdaq, EUR/USD (IBS).'),
    ])] + example('repli', 'points', 5, 'MES') + [Spacer(1, 6)] + example('double7', 'points', 5, 'MES')

    out += [PageBreak(), Paragraph('9. Filtres « macro » (journalier)', h2), Paragraph(
        '<b>L’idée</b> : certains marchés réagissent aux autres. On ne fait que regarder un autre graphique avant d’acheter.', body), Spacer(1, 3), rules([
        ('Dollar en baisse', 'Indice du dollar (DXY) −2 % en 10 séances et Nasdaq au-dessus de sa moyenne 50 jours → achat du Nasdaq ; revente quand le DXY repasse au-dessus de sa moyenne 10 jours.'),
        ('Or en baisse', 'Or −4 % en 10 séances et Nasdaq / S&amp;P au-dessus de leur moyenne 50 jours → achat ; revente quand l’or repasse au-dessus de sa moyenne 10 jours.'),
        ('Taux en baisse', 'Taux 10 ans US (^TNX) −5 % en 5 séances et or au-dessus de sa moyenne 50 jours → achat de l’or ; revente quand les taux repassent au-dessus de leur moyenne 10 jours.'),
        ('Taux bas', 'Taux 10 ans sous sa moyenne 50 jours ET Nasdaq au-dessus de sa moyenne 50 jours → être acheté ; sortir dès qu’une des deux conditions tombe (stop 4 ATR).'),
        ('Moyennes', 'Or : EMA 20 qui croise au-dessus de l’EMA 50 (RSI &lt; 70) → achat, stop 1,5 ATR, objectif 3 ATR. Bollinger : clôture sous la bande basse au-dessus de la moyenne 200 → achat, revente sur la moyenne 20.'),
    ])]

    out += [Paragraph('10. La routine de la journée', h2), table([
        ('Heure (Paris, hiver)', 'À faire'),
        ('1 h → 8 h', 'Or : la nuit asiatique fixe son range (rien à faire, regarder au réveil).'),
        ('8 h → 10 h 30', 'Or : range de Londres (8 h → 8 h 30), cassures de Londres et du range asiatique.'),
        ('15 h 30 → 16 h 30', 'Nasdaq / S&amp;P / Dow / argent : noter les ranges d’ouverture (5, 10, 15, 30, 60 min), vérifier si hier était NR4 / NR7, calculer les seuils de Williams.'),
        ('16 h', 'Noter le mouvement depuis la clôture d’hier (momentum de 21 h).'),
        ('21 h → 21 h 55', 'Momentum de fin de journée ; tout fermer à 21 h 55.'),
        ('22 h (clôture)', 'Journalier : RSI 2, Double 7, 3 baisses, IBS… à la clôture ; revoir les sorties des positions en cours.'),
    ], [42 * mm, 138 * mm]), Spacer(1, 4), Paragraph(
        '<b>Discipline</b> : noter chaque trade (date, règle, entrée, stop, objectif, résultat en R) ; ne prendre que les trades qui respectent '
        'EXACTEMENT la règle ; s’arrêter pour la journée après une grosse perte ; sur Lucid, ne pas faire plus de 40 % de l’objectif en un jour. '
        'Une stratégie qui gagne en moyenne +0,1 à +0,2 R par trade perd souvent plusieurs fois de suite : c’est normal, c’est la répétition qui paie. '
        'Les résultats passés ne garantissent rien — commence en simulation ou en compte démo.', body)]
    return out
