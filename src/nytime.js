/**
 * Heure de New York rapide (sans Intl à chaque bougie) : décalage UTC calculé une fois par heure UTC puis gardé en
 * mémoire (le passage heure d'été / d'hiver se fait à une heure pile). Utilisé pour filtrer des milliers de bougies
 * à chaque passage (séance de New York, heures des métaux) : ≈ 50 fois plus rapide que formatToParts.
 */
const OFF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
const cache = new Map();
function offsetSec(t) {
  const h = Math.floor(t / 3600);
  let o = cache.get(h);
  if (o === undefined) {
    const s = OFF.formatToParts(new Date(h * 3600 * 1000)).find((p) => p.type === 'timeZoneName').value; // « GMT-5 »
    o = (Number((s.match(/GMT([+-]\d+)/) || [])[1]) || -5) * 3600;
    if (cache.size > 200_000) cache.clear();
    cache.set(h, o);
  }
  return o;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
/** { weekday: 'Mon', min: minutes depuis minuit, hour, day: 'AAAA-MM-JJ' } à New York. */
function nyParts(t) {
  const d = new Date((t + offsetSec(t)) * 1000);
  const hour = d.getUTCHours();
  return { weekday: WD[d.getUTCDay()], hour, min: hour * 60 + d.getUTCMinutes(), day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` };
}
module.exports = { nyParts, offsetSec };
