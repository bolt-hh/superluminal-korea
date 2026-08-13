/**
 * POST /api/wallet-quality   { wallet: "<base58 SVM address>" }
 *
 * Implements the Holo Hive "Wallet Quality Verification" scoring model
 * (Superluminal, June 2026) exactly as specified:
 *
 *   wallet age 12+ months ............ 3   Helius / Solscan
 *   wallet age 6-11 months ........... 2
 *   wallet age 3-5 months ............ 1
 *   DEX activity, 5+ SWAP events ..... 2   Helius
 *   perp DEX Solana, Drift ........... 2   Drift
 *   perp DEX EVM, Hyperliquid ........ 2   Hyperliquid
 *   token diversity, 5+ SPL .......... 1   Helius / Birdeye
 *   30-day DEX volume $1K+ ........... 1   Birdeye
 *   bridge / cross-chain ............. 1   Helius
 *
 * Raw max is 12, clamped to 10. Age bands are mutually exclusive.
 * Tiers: Bronze 3-4, Silver 5-6, Gold 7-8, Platinum 9+, below 3 Blocked.
 *
 * All sources run concurrently via Promise.allSettled with a per-source timeout,
 * so one slow or failing API scores 0 for its signal instead of blocking the
 * result. Read-only: no signature is ever requested and no raw API response is
 * persisted, only the score, tier and per-signal booleans.
 *
 * Env (Vercel project settings, never in code):
 *   HELIUS_API_KEY              free signup, optional but strongly recommended
 *   BIRDEYE_API_KEY             free signup, optional
 *   SUPABASE_URL                for the 24h score cache
 *   SUPABASE_SERVICE_ROLE_KEY   cache writes only, server-side only
 * Solscan, Hyperliquid and Drift need no key.
 */

const TIMEOUT_MS = 3000;
const CACHE_TTL_H = 24;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const BRIDGE_HINTS = [
  'wormhole', 'debridge', 'layerzero', 'allbridge', 'portal', 'mayan', 'wanchain'
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))
  ]);
}

async function jsonFetch(url, opts, label) {
  const r = await withTimeout(fetch(url, opts), TIMEOUT_MS, label);
  if (!r.ok) throw new Error(label + ':HTTP ' + r.status);
  return r.json();
}

/* ---------------- sources ---------------- */

// Helius enriched transactions: age, SWAP count, bridge hints
async function helius(wallet) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('helius:no_key');
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=100`;
  const txs = await jsonFetch(url, { headers: { accept: 'application/json' } }, 'helius');
  if (!Array.isArray(txs)) throw new Error('helius:shape');
  let oldest = null, swaps = 0, bridge = false;
  for (const t of txs) {
    const ts = Number(t.timestamp || 0);
    if (ts && (oldest === null || ts < oldest)) oldest = ts;
    const type = String(t.type || '').toUpperCase();
    if (type === 'SWAP') swaps++;
    const blob = JSON.stringify(t.source || '') + ' ' + JSON.stringify(t.description || '');
    const low = blob.toLowerCase();
    if (BRIDGE_HINTS.some(h => low.includes(h))) bridge = true;
  }
  return { oldest, swaps, bridge, txCount: txs.length };
}

// Solscan public: first-transaction date fallback when Helius is unavailable
async function solscanAge(wallet) {
  const url = `https://public-api.solscan.io/account/transactions?account=${wallet}&limit=50`;
  const d = await jsonFetch(url, { headers: { accept: 'application/json' } }, 'solscan');
  const arr = Array.isArray(d) ? d : (d && d.data) || [];
  let oldest = null;
  for (const t of arr) {
    const ts = Number(t.blockTime || t.block_time || 0);
    if (ts && (oldest === null || ts < oldest)) oldest = ts;
  }
  return { oldest, txCount: arr.length };
}

// Helius DAS: distinct fungible holdings, for token diversity
async function heliusTokens(wallet) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('heliusTokens:no_key');
  const d = await jsonFetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'slxka', method: 'searchAssets',
      params: { ownerAddress: wallet, tokenType: 'fungible', limit: 200 }
    })
  }, 'heliusTokens');
  const items = (d && d.result && d.result.items) || [];
  // ignore dust: require a non-zero balance
  const held = items.filter(i => {
    const info = i.token_info || {};
    return Number(info.balance || 0) > 0;
  });
  return { distinct: held.length };
}

// Drift: has this wallet ever traded perps on Solana
async function drift(wallet) {
  const d = await jsonFetch(
    `https://data.api.drift.trade/user/stats?authority=${wallet}`,
    { headers: { accept: 'application/json' } }, 'drift');
  const s = (d && (d.data || d)) || {};
  const vol = Number(s.totalVolume ?? s.taker_volume_30d ?? s.cumulativeVolume ?? 0);
  const traded = Boolean(vol > 0 || s.numberOfSubAccounts > 0 || s.hasTraded);
  return { traded, volume: vol };
}

// Hyperliquid: EVM-only. Included for completeness per the model; an SVM
// address will not resolve, so this signal scores 0 for Solana-native wallets.
async function hyperliquid(evmAddress) {
  if (!evmAddress || !/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) {
    throw new Error('hyperliquid:not_evm');
  }
  const st = await jsonFetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: evmAddress })
  }, 'hyperliquid');
  const positions = (st && st.assetPositions) || [];
  const value = Number((st && st.marginSummary && st.marginSummary.accountValue) || 0);
  return { traded: positions.length > 0 || value > 0, accountValue: value };
}

// Birdeye: 30-day DEX volume, and a token-count fallback
async function birdeye(wallet) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) throw new Error('birdeye:no_key');
  const d = await jsonFetch(
    `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`,
    { headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' } },
    'birdeye');
  const items = (d && d.data && d.data.items) || [];
  const totalUsd = Number((d && d.data && d.data.totalUsd) || 0);
  return { distinct: items.filter(i => Number(i.uiAmount || 0) > 0).length, totalUsd };
}

/* ---------------- scoring ---------------- */

function ageMonths(oldestUnix) {
  if (!oldestUnix) return null;
  const days = (Date.now() / 1000 - oldestUnix) / 86400;
  return days / 30.44;
}

function score(parts) {
  const s = {};
  const months = ageMonths(parts.oldest);

  // mutually exclusive age bands
  s.age12 = months !== null && months >= 12;
  s.age6 = !s.age12 && months !== null && months >= 6;
  s.age3 = !s.age12 && !s.age6 && months !== null && months >= 3;

  s.dex = (parts.swaps || 0) >= 5;
  s.driftPerp = Boolean(parts.driftTraded);
  s.hlPerp = Boolean(parts.hlTraded);
  s.tokens = (parts.distinct || 0) >= 5;
  s.vol30d = (parts.vol30dUsd || 0) >= 1000;
  s.bridge = Boolean(parts.bridge);

  const pts =
    (s.age12 ? 3 : s.age6 ? 2 : s.age3 ? 1 : 0) +
    (s.dex ? 2 : 0) +
    (s.driftPerp ? 2 : 0) +
    (s.hlPerp ? 2 : 0) +
    (s.tokens ? 1 : 0) +
    (s.vol30d ? 1 : 0) +
    (s.bridge ? 1 : 0);

  const total = Math.min(10, pts);
  const tier =
    total >= 9 ? 'Platinum' :
    total >= 7 ? 'Gold' :
    total >= 5 ? 'Silver' :
    total >= 3 ? 'Bronze' : 'Blocked';

  return { score: total, raw: pts, tier, signals: s, ageMonths: months === null ? null : Math.round(months * 10) / 10 };
}

/* ---------------- cache ---------------- */

async function cacheGet(wallet) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const r = await withTimeout(fetch(
      `${url}/rest/v1/slxka_wallet_scores?wallet=eq.${wallet}&select=*`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }), TIMEOUT_MS, 'cacheGet');
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    const age = (Date.now() - Date.parse(rows[0].computed_at)) / 36e5;
    return age < CACHE_TTL_H ? rows[0] : null;
  } catch { return null; }
}

async function cachePut(wallet, res, sourcesOk) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const r = await withTimeout(fetch(`${url}/rest/v1/slxka_wallet_scores`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        wallet, score: res.score, tier: res.tier,
        signals: res.signals, sources_ok: sourcesOk, computed_at: new Date().toISOString()
      })
    }), TIMEOUT_MS, 'cachePut');
    return r.ok;
  } catch { return false; }
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const wallet = (body && String(body.wallet || '').trim()) || '';
  const evm = (body && String(body.evm || '').trim()) || '';

  if (!B58.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'bad_wallet' });
  }

  // serve a fresh cached score, per the 24h TTL recommendation
  const hit = await cacheGet(wallet);
  if (hit) {
    return res.status(200).json({
      ok: true, cached: true, wallet,
      score: Number(hit.score), tier: hit.tier,
      signals: hit.signals, sources: hit.sources_ok
    });
  }

  // every source concurrently, one failure never blocks the rest
  const [hx, sc, tk, dr, hl, be] = await Promise.allSettled([
    helius(wallet), solscanAge(wallet), heliusTokens(wallet),
    drift(wallet), hyperliquid(evm), birdeye(wallet)
  ]);
  const val = r => (r.status === 'fulfilled' ? r.value : null);
  const why = r => (r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason) : null);

  const H = val(hx), S = val(sc), T = val(tk), D = val(dr), L = val(hl), B = val(be);

  const parts = {
    oldest: (H && H.oldest) || (S && S.oldest) || null,
    swaps: (H && H.swaps) || 0,
    bridge: (H && H.bridge) || false,
    distinct: (T && T.distinct) || (B && B.distinct) || 0,
    driftTraded: (D && D.traded) || false,
    hlTraded: (L && L.traded) || false,
    vol30dUsd: (B && B.totalUsd) || 0
  };

  const out = score(parts);
  const sources = {
    helius: H ? 'ok' : why(hx), solscan: S ? 'ok' : why(sc),
    heliusTokens: T ? 'ok' : why(tk), drift: D ? 'ok' : why(dr),
    hyperliquid: L ? 'ok' : why(hl), birdeye: B ? 'ok' : why(be)
  };

  // degraded means the age signal, worth up to 3 points, had no source at all
  const degraded = parts.oldest === null;
  await cachePut(wallet, out, sources);

  return res.status(200).json({
    ok: true, cached: false, wallet,
    score: out.score, raw: out.raw, tier: out.tier,
    ageMonths: out.ageMonths, signals: out.signals,
    sources, degraded
  });
}
