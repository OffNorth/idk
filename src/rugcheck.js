/**
 * Vérification de sécurité via RugCheck (Solana uniquement).
 * Rejet direct si le dev peut encore minter ou geler les tokens.
 */
const { getJson } = require('./http');

const HARD_FAIL = [/mint authority/i, /freeze authority/i];

async function check(address) {
  const data = await getJson(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`, { quiet: true });
  if (!data) return { available: false };
  const risks = (data.risks || []).map((r) => ({ name: r.name, level: r.level, value: r.value }));
  const fatal = risks.find((r) => HARD_FAIL.some((re) => re.test(r.name)));
  return {
    available: true,
    score: data.score_normalised ?? null, // 0 = sûr, 100 = très risqué
    lpLockedPct: data.lpLockedPct ?? null,
    risks,
    dangers: risks.filter((r) => r.level === 'danger').map((r) => r.name),
    fatal: fatal ? fatal.name : null,
  };
}

module.exports = { check };
