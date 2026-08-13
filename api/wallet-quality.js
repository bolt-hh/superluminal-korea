/**
 * POST /api/wallet-quality   { wallet: "<base58 SVM address>" }
 *
 * Implements the Holo Hive "Wallet Quality Verification" scoring model
 * (Superluminal, June 2026) exactly as specified:
 *
 *   wallet age 12+ months ............ 3   Helius RPC, paged to first tx
 *   wallet age 6-11 months ........... 2
 *   wallet age 3-5 months ............ 1
 *   DEX activity, 5+ SWAP events ..... 2   Helius
 *   perp DEX Solana .................. 2   on-chain PDA probe, Velocity + Drift
 *   perp DEX EVM, Hyperliquid ........ 2   Hyperliquid
 *   token diversity, 5+ SPL .......... 1   Helius DAS
 *   30-day DEX volume $1K+ ........... 1   Birdeye trader trades
 *   bridge / cross-chain ............. 1   Helius
 *
 * Raw max is 12, clamped to 10. Age bands are mutually exclusive.
 * Tiers: Bronze 3-4, Silver 5-6, Gold 7-8, Platinum 9+, below 3 Blocked.
 *
 * Two notes on the Solana perp signal. First, Drift relaunched as Velocity on a
 * new program id and the Drift program is legacy/paused, so the model's "Drift"
 * signal has to cover both: Velocity for anyone trading perps today, Drift for
 * anyone who traded before the migration. Second, neither has a public endpoint
 * that takes a wallet authority, so this asks the chain directly: derive the
 * user-account PDA for each program and see whether it exists. One RPC call,
 * no key beyond Helius, and it cannot be gamed.
 *
 * All sources run concurrently via Promise.allSettled with a per-source timeout,
 * so one slow or failing API scores 0 for its signal instead of blocking the
 * result. Read-only: no signature is ever requested and no raw API response is
 * persisted, only the score, tier and per-signal booleans.
 *
 * Env (Vercel project settings, never in code):
 *   HELIUS_API_KEY              free signup, carries age, swaps, tokens, perps
 *   BIRDEYE_API_KEY             free "Standard" package is enough
 *   SUPABASE_URL                for the 24h score cache
 *   SUPABASE_SERVICE_ROLE_KEY   cache writes only, server-side only
 * Hyperliquid needs no key.
 */

import { createHash } from 'node:crypto';

const TIMEOUT_MS = 3000;
const CACHE_TTL_H = 24;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* Solana perp programs whose user accounts we probe for. Velocity is the live
   deployment; Drift is the paused predecessor, kept because prior perp history
   is exactly what the model is trying to detect. */
const PERP_PROGRAMS = [
  { name: 'velocity', id: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P' },
  { name: 'drift',    id: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH' }
];

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

// Helius enriched transactions: SWAP count + bridge hints (recent window)
async function helius(wallet) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('helius:no_key');
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=100`;
  const txs = await jsonFetch(url, { headers: { accept: 'application/json' } }, 'helius');
  if (!Array.isArray(txs)) throw new Error('helius:shape');
  let swaps = 0, bridge = false;
  for (const t of txs) {
    if (String(t.type || '').toUpperCase() === 'SWAP') swaps++;
    const low = (JSON.stringify(t.source || '') + ' ' + JSON.stringify(t.description || '')).toLowerCase();
    if (BRIDGE_HINTS.some(h => low.includes(h))) bridge = true;
  }
  return { swaps, bridge, txCount: txs.length };
}

/* True wallet age. getSignaturesForAddress returns newest-first, so the oldest
   transaction is only reachable by paging with `before`. We walk back up to
   MAX_PAGES x 1000 signatures. If a page comes back short we have hit the very
   first transaction and the age is exact; otherwise the wallet is at least as
   old as the oldest signature we saw, which is all the banding needs. */
async function walletAge(wallet) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('walletAge:no_key');
  const rpc = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const MAX_PAGES = 3, PAGE = 1000;
  const BUDGET_MS = 6000, t0 = Date.now();   // stay inside the function's 10s ceiling
  let before = null, oldest = null, exact = false, seen = 0;

  for (let i = 0; i < MAX_PAGES; i++) {
    if (Date.now() - t0 > BUDGET_MS) break;   // partial age is still usable for banding
    const params = [wallet, before ? { limit: PAGE, before } : { limit: PAGE }];
    const d = await jsonFetch(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'slxka-age', method: 'getSignaturesForAddress', params })
    }, 'walletAge');
    const rows = (d && d.result) || [];
    if (!rows.length) { exact = true; break; }
    seen += rows.length;
    const last = rows[rows.length - 1];
    if (last && last.blockTime) oldest = last.blockTime;
    before = last && last.signature;
    if (rows.length < PAGE) { exact = true; break; }
  }
  return { oldest, exact, seen };
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

/* ---- base58, so we can derive PDAs without pulling in @solana/web3.js ---- */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(str) {
  const bytes = [];          // must start empty: a seeded [0] adds a phantom byte
  for (const ch of str) {    // on all-zero inputs and yields a 33-byte key
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('b58:bad_char');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function b58encode(buf) {
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let k = 0; k < buf.length && buf[k] === 0; k++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/* One PDA candidate. The canonical address is whichever bump find_program_address
   landed on; rather than reimplement the ed25519 on-curve test we generate the
   top BUMP_SPAN candidates and ask the chain about all of them at once. Missing
   the canonical bump needs every one of those to be on-curve, which is 2^-16. */
const BUMP_SPAN = 16;

function programAddressCandidates(programIdB58, authorityB58) {
  const programId = b58decode(programIdB58);
  const authority = b58decode(authorityB58);
  const subAccount = Buffer.from([0, 0]);          // sub-account 0, u16 little-endian
  const out = [];
  for (let bump = 255; bump > 255 - BUMP_SPAN; bump--) {
    const h = createHash('sha256');
    h.update(Buffer.from('user', 'utf8'));
    h.update(authority);
    h.update(subAccount);
    h.update(Buffer.from([bump]));
    h.update(programId);
    h.update(Buffer.from('ProgramDerivedAddress', 'utf8'));
    out.push(b58encode(h.digest()));
  }
  return out;
}

/* Has this wallet ever opened a perp account on Solana? Velocity today, Drift
   before the migration. One getMultipleAccounts covers both programs: an account
   that exists AND is owned by the program can only have been created by it. */
async function solanaPerps(wallet) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('solanaPerps:no_key');

  const owners = new Map();
  const addresses = [];
  for (const p of PERP_PROGRAMS) {
    for (const addr of programAddressCandidates(p.id, wallet)) {
      owners.set(addr, p);
      addresses.push(addr);
    }
  }

  const d = await jsonFetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'slxka-perps', method: 'getMultipleAccounts',
      params: [addresses, { encoding: 'base64', commitment: 'confirmed' }]
    })
  }, 'solanaPerps');

  const values = (d && d.result && d.result.value) || [];
  const on = [];
  values.forEach((v, i) => {
    if (!v) return;
    const expected = owners.get(addresses[i]);
    if (expected && v.owner === expected.id) on.push(expected.name);
  });
  return { traded: on.length > 0, venues: on };
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

/* Birdeye: real 30-day DEX volume.
   The obvious endpoint, /v1/wallet/token_list, is gated to the paid Lite tier
   and 401s on the free Standard package. It was also the wrong measure: it
   returns current portfolio value, not traded volume. /trader/txs/seek_by_time
   is on Standard, and gives per-trade volume_usd inside a time window.
   The 100-item cap makes the total a floor, which is all a $1K threshold needs. */
async function birdeye(wallet) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) throw new Error('birdeye:no_key');
  const after = Math.floor(Date.now() / 1000) - 30 * 86400;
  const d = await jsonFetch(
    `https://public-api.birdeye.so/trader/txs/seek_by_time` +
      `?address=${wallet}&offset=0&limit=100&tx_type=swap&after_time=${after}`,
    { headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' } },
    'birdeye');
  const data = (d && d.data) || {};
  const items = data.items || [];
  let usd = 0;
  for (const t of items) usd += Number(t.volume_usd || 0);
  return {
    vol30dUsd: usd,
    trades30d: items.length,
    partial: Boolean(data.hasNext || data.has_next)
  };
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
    helius(wallet), walletAge(wallet), heliusTokens(wallet),
    solanaPerps(wallet), hyperliquid(evm), birdeye(wallet)
  ]);
  const val = r => (r.status === 'fulfilled' ? r.value : null);
  const why = r => (r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason) : null);

  const H = val(hx), A = val(sc), T = val(tk), D = val(dr), L = val(hl), B = val(be);

  const parts = {
    oldest: (A && A.oldest) || null,
    swaps: (H && H.swaps) || 0,
    bridge: (H && H.bridge) || false,
    distinct: (T && T.distinct) || 0,
    driftTraded: (D && D.traded) || false,
    hlTraded: (L && L.traded) || false,
    vol30dUsd: (B && B.vol30dUsd) || 0
  };

  const out = score(parts);
  const sources = {
    helius: H ? 'ok' : why(hx), walletAge: A ? 'ok' : why(sc),
    heliusTokens: T ? 'ok' : why(tk), solanaPerps: D ? 'ok' : why(dr),
    hyperliquid: L ? 'ok' : why(hl), birdeye: B ? 'ok' : why(be)
  };

  // degraded means the age signal, worth up to 3 points, had no source at all
  const degraded = parts.oldest === null;
  await cachePut(wallet, out, sources);

  return res.status(200).json({
    ok: true, cached: false, wallet,
    score: out.score, raw: out.raw, tier: out.tier,
    ageMonths: out.ageMonths, ageExact: A ? A.exact : null, signals: out.signals,
    perpVenues: (D && D.venues) || [],
    vol30dUsd: Math.round(parts.vol30dUsd),
    sources, degraded
  });
}
