#!/usr/bin/env python3
"""
Historique long de l'or au comptant (XAU/USD) en bougies 1 min, données gratuites de HistData.com (2009 → aujourd'hui),
regroupé en bougies 5 min pour le banc d'essai (npm run ftmo-long). Remplace Dukascopy, qui coupe les connexions
venant de ce serveur.

    python3 scripts/histdata.py [première année]

- un fichier ZIP par année passée, un par mois pour l'année en cours, mis en cache dans data/research/histdata/ ;
- heures HistData = heure de New York SANS changement d'heure (UTC−5 toute l'année) → converties en UTC ;
- sortie : data/research/xauusd-5m.json = [[t, o, h, l, c, v], …] (t en secondes UTC).
"""
import datetime, io, json, os, re, sys, time, urllib.parse, urllib.request, zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(ROOT, 'data', 'research', 'histdata')
OUT = os.path.join(ROOT, 'data', 'research', 'xauusd-5m.json')
PAGE = 'https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/xauusd/{p}'
os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0'}


def download(year, month=None):
    name = f'{year}{month:02d}' if month else f'{year}'
    path = os.path.join(CACHE, f'XAUUSD_M1_{name}.zip')
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    page = PAGE.format(p=f'{year}/{month}' if month else year)
    html = urllib.request.urlopen(urllib.request.Request(page, headers=UA), timeout=60).read().decode('utf8', 'ignore')
    m = re.search(r'name="tk" id="tk" value="([0-9a-f]+)"', html)
    if not m:
        return None
    body = urllib.parse.urlencode({'tk': m.group(1), 'date': year, 'datemonth': name, 'platform': 'ASCII', 'timeframe': 'M1', 'fxpair': 'XAUUSD'}).encode()
    req = urllib.request.Request('https://www.histdata.com/get.php', data=body, headers={**UA, 'Referer': page})
    data = urllib.request.urlopen(req, timeout=180).read()
    if data[:2] != b'PK':
        return None
    open(path, 'wb').write(data)
    time.sleep(2)
    return path


first = int(sys.argv[1]) if len(sys.argv) > 1 else 2009
today = datetime.date.today()
files = []
for y in range(first, today.year):
    p = download(y)
    print(f'{y} : {"ok" if p else "absent"}', flush=True)
    if p:
        files.append(p)
for mo in range(1, today.month + 1):
    try:
        p = download(today.year, mo)
    except Exception as e:  # mois en cours pas encore publié
        p = None
    print(f'{today.year}-{mo:02d} : {"ok" if p else "absent"}', flush=True)
    if p:
        files.append(p)

bars5 = {}
for f in files:
    z = zipfile.ZipFile(f)
    for n in z.namelist():
        if not n.endswith('.csv'):
            continue
        for line in io.TextIOWrapper(z.open(n), encoding='utf8'):
            parts = line.strip().split(';')
            if len(parts) < 5:
                continue
            ts = datetime.datetime.strptime(parts[0], '%Y%m%d %H%M%S').replace(tzinfo=datetime.timezone.utc)
            t = int(ts.timestamp()) + 5 * 3600  # UTC−5 fixe → UTC
            o, h, l, c = (float(x) for x in parts[1:5])
            k = t - t % 300
            b = bars5.get(k)
            if b is None:
                bars5[k] = [k, o, h, l, c, 1]
            else:
                b[2] = max(b[2], h); b[3] = min(b[3], l); b[4] = c; b[5] += 1

rows = [bars5[k] for k in sorted(bars5)]
json.dump([[r[0], round(r[1], 3), round(r[2], 3), round(r[3], 3), round(r[4], 3), r[5]] for r in rows], open(OUT, 'w'), separators=(',', ':'))
print(f'Écrit {OUT} : {len(rows)} bougies 5 min ({len(files)} fichiers)')
