#!/usr/bin/env python3
"""
Historique long de l'or au comptant (XAU/USD) en bougies 1 min, données publiques gratuites de Dukascopy (2004 → aujourd'hui),
regroupé en bougies 5 min pour le banc d'essai (bien plus long que l'archive PAXG de Binance, qui commence en 2020).

    python3 scripts/dukascopy.py [AAAA-MM-JJ début] [AAAA-MM-JJ fin]

- un fichier par jour (BID_candles_min_1.bi5, compressé LZMA), mis en cache dans data/research/duka/XAUUSD/ ;
- requêtes lentes (une à la fois, 1 s de pause, jusqu'à 12 essais avec attente croissante : le service limite le débit) pour ne pas surcharger le service ;
- sortie : data/research/xauusd-5m.json = [[t, o, h, l, c, v], …] (t en secondes UTC), week-ends et bougies vides retirés.
"""
import datetime, json, lzma, os, struct, sys, time, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(ROOT, 'data', 'research', 'duka', 'XAUUSD')
OUT = os.path.join(ROOT, 'data', 'research', 'xauusd-5m.json')
URL = 'https://datafeed.dukascopy.com/datafeed/XAUUSD/{y}/{m:02d}/{d:02d}/BID_candles_min_1.bi5'
os.makedirs(CACHE, exist_ok=True)

start = datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.date(2004, 1, 1)
end = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else datetime.date.today() - datetime.timedelta(days=1)


def fetch(day):
    path = os.path.join(CACHE, day.isoformat() + '.bi5')
    if os.path.exists(path):
        return open(path, 'rb').read()
    url = URL.format(y=day.year, m=day.month - 1, d=day.day)  # mois numérotés à partir de 0
    for attempt in range(12):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            data = urllib.request.urlopen(req, timeout=30).read()
            open(path, 'wb').write(data)
            time.sleep(1.0)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(path, 'wb').write(b'')
                return b''
            time.sleep(min(60, 3 * 2 ** min(attempt, 4)))
        except Exception:
            time.sleep(min(60, 3 * 2 ** min(attempt, 4)))
    return None


def candles(day, raw):
    if not raw:
        return []
    try:
        d = lzma.decompress(raw)
    except lzma.LZMAError:
        return []
    base = int(datetime.datetime(day.year, day.month, day.day, tzinfo=datetime.timezone.utc).timestamp())
    out = []
    for k in range(len(d) // 24):
        t, o, c, l, h, v = struct.unpack('>5if', d[k * 24:(k + 1) * 24])
        if v <= 0:
            continue
        out.append((base + t, o / 1000, h / 1000, l / 1000, c / 1000, v))
    return out


bars5 = {}
day = start
n = 0
missing = 0
while day <= end:
    if day.weekday() < 5 or day.weekday() == 6:  # le marché rouvre le dimanche soir
        raw = fetch(day)
        if raw is None:
            missing += 1
        for t, o, h, l, c, v in candles(day, raw):
            k = t - t % 300
            b = bars5.get(k)
            if b is None:
                bars5[k] = [k, o, h, l, c, v]
            else:
                b[2] = max(b[2], h); b[3] = min(b[3], l); b[4] = c; b[5] += v
        n += 1
        if n % 250 == 0:
            print(f'{day} : {n} jours, {len(bars5)} bougies 5 min', flush=True)
    day += datetime.timedelta(days=1)

rows = [bars5[k] for k in sorted(bars5)]
json.dump([[r[0], round(r[1], 3), round(r[2], 3), round(r[3], 3), round(r[4], 3), round(r[5], 2)] for r in rows], open(OUT, 'w'), separators=(',', ':'))
print(f'Écrit {OUT} : {len(rows)} bougies 5 min, {start} → {end}, {missing} jours manquants')
