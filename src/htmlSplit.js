/**
 * Messages Telegram en HTML : limite de 4 096 caractères. Couper au milieu d'une balise (<b>…) fait refuser tout le
 * message (« can't parse entities »). On coupe donc entre deux lignes, jamais au milieu.
 */
const strip = (s) => s.replace(/<[^>]+>/g, '');
/** Découpe un texte HTML en morceaux ≤ max caractères, aux fins de ligne (une ligne trop longue perd son HTML). */
function splitHtml(text, max = 4000) {
  const out = [];
  let cur = '';
  for (let line of String(text).split('\n')) {
    if (line.length > max) line = strip(line).slice(0, max - 1) + '…';
    if (cur && cur.length + 1 + line.length > max) { out.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
/** Premier morceau seulement, avec « … » si le texte a été raccourci. */
function truncHtml(text, max = 4000) {
  const parts = splitHtml(text, max - 2);
  return parts.length > 1 ? `${parts[0]}\n…` : parts[0];
}
module.exports = { splitHtml, truncHtml };
