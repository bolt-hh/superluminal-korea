# Superluminal Korea Activation

Community activation site. Static single-file frontend, one Vercel serverless function
for wallet scoring, Supabase backend. Reown AppKit for wallet connect.

**Entries are currently OPEN for internal testing.** Treat the URL as internal until the
pre-launch list below is cleared. See "Before you send this anywhere public".

---

## Deploy

```bash
git init
git add .
git commit -m "Superluminal Korea Activation"
git branch -M main
git remote add origin git@github.com:Holo-Hive/superluminal-korea-activation.git
git push -u origin main
```

Vercel: **Add New → Project → Import**, team **holo-hive**, framework preset **Other**.
No build command, no output directory. Vercel serves `index.html` and auto-detects
`api/wallet-quality.js` as a function. `vercel.json` applies the headers and CSP.
Enable **Web Analytics** and **Speed Insights**. Do not attach a custom domain yet.

### Environment variables (Vercel project settings, never in code)

| Variable | Needed for | Without it |
|---|---|---|
| `SUPABASE_URL` | score cache | scoring works, nothing is cached, entries fail on `score_missing` |
| `SUPABASE_SERVICE_ROLE_KEY` | score cache writes | same as above |
| `HELIUS_API_KEY` | wallet age, swap count, token count, bridge, perp check | loses up to 9 of 10 points, nearly every wallet falls under Silver |
| `BIRDEYE_API_KEY` | 30-day DEX volume | loses 1 point |

`SUPABASE_URL` is `https://dcpgnltlnkvzzwtmbpyv.supabase.co`. The service key is in the
Supabase dashboard under Project Settings → API. Helius and Birdeye are free signups and the
free tiers are sufficient. Hyperliquid needs no key.

Birdeye's free package is called **Standard**. The wallet-portfolio endpoint
`/v1/wallet/token_list` is *not* on it and returns 401, which is what the earlier build hit;
this one uses `/trader/txs/seek_by_time`, which is on Standard and, unlike the portfolio
endpoint, actually measures traded volume rather than current holdings.

**The first two are mandatory.** Without the cache the scoring endpoint returns a score
but nothing is persisted, and `create_entry` refuses every submission with `score_missing`.

### Reown

Project id `0ebdc1b350b890b0042e03a793980776` (the Holo Hive project, same as Fogo).
**Add the deployed domain to the allowlist in the Reown dashboard**, or AppKit will fail
to initialise and only desktop extension wallets will work.

AppKit is pinned to **1.6.8**, the build proven in production on the Fogo activation. Do not
float this to `@1`: the connect flow depends on behaviour that is not covered by semver.

Connect reads `getAddress()` / `getIsConnectedState()` **before** waiting on any event.
`subscribeAccount` and `subscribeState` fire only on *change*, so a session AppKit restored
at init, or a modal that is already open, emits nothing at all. Anything that waits purely
on those events hangs forever. State is polled every 400ms, and re-read on `visibilitychange`
and `focus` because Chrome throttles timers while the user is away in their wallet app.

---

## How an entry is created

1. User enters their **X handle and Telegram handle**, then connects a wallet through
   Reown AppKit (Solana adapter, testnet networks). Falls back to injected Phantom /
   Solflare / Backpack if AppKit cannot load.
2. The site asks for an **ed25519 signature** over a message carrying the wallet address,
   the origin and a nonce. This proves ownership for payout and cannot be replayed onto
   another site or another entry. It is free and moves no funds.
3. Connecting does **not** score. The user presses **Score my wallet**, which calls
   `POST /api/wallet-quality`. The function scores the wallet server-side and caches the
   result for 24 hours. Splitting the two means a reconnect never silently re-runs the
   API calls, and both handles are validated before any are spent.
4. Quiz: 7 questions, all must be correct, unlimited retries. Verified server-side against
   `slxka_quiz_key`, which is never readable by the browser.
5. Trade on testnet, then submit. `slxka_create_entry` reads the **stored** score, ignores
   whatever the client claims, computes the band and entry count, and writes the row.

---

## Wallet quality scoring

`api/wallet-quality.js` implements the Holo Hive Wallet Quality Verification model
(Superluminal, June 2026) exactly:

| Signal | Points | Source |
|---|---|---|
| Wallet age 12+ months | 3 | Helius RPC, paged to first transaction |
| Wallet age 6-11 months | 2 | as above |
| Wallet age 3-5 months | 1 | as above |
| 5+ DEX swap events | 2 | Helius |
| Solana perp history | 2 | on-chain, Velocity + Drift |
| Hyperliquid perp history | 2 | Hyperliquid |
| 5+ distinct tokens held | 1 | Helius DAS |
| $1K+ 30-day DEX volume | 1 | Birdeye |
| Bridge or cross-chain activity | 1 | Helius |

Age bands are mutually exclusive. Raw max is 12, clamped to 10.
Tiers: **Bronze 3-4, Silver 5-6, Gold 7-8, Platinum 9+**, below 3 is Blocked.
Entry gate is **Silver (5+)**, the model's recommended default.

All sources run concurrently through `Promise.allSettled` with a 3s per-source timeout, so
one failing API scores 0 for its signal instead of blocking the result. The response
includes a `sources` map so you can see which APIs answered, and `degraded: true` when no
source could establish wallet age.

### Wallet age is paged, not sampled

`getSignaturesForAddress` returns newest-first, so a single call describes recent activity,
not the age of the wallet. The function pages backwards with a `before` cursor until a short
page proves it has reached the first transaction, bounded to 3 pages and a 6s budget to stay
inside the function's 10s ceiling. `ageExact` reports whether the oldest transaction found is
genuinely the first one; when it is false the wallet is *at least* that old, which is all the
banding needs.

### The Solana perp signal reads the chain directly

Drift relaunched as **Velocity** on a new program id and the Drift program is legacy and
paused, so this signal covers both: Velocity for anyone trading perps now, Drift for anyone
who traded before the migration. Neither exposes a public endpoint keyed by wallet authority,
so instead of an API the function derives each program's user-account PDA for the wallet and
asks whether it exists. An account that exists **and** is owned by the program can only have
been created by that program, so the check cannot be spoofed, needs no key beyond Helius, and
costs one `getMultipleAccounts` call.

PDA derivation is done without `@solana/web3.js`: base58 and sha256 are implemented inline and
the top 16 bump candidates are probed in the single batch rather than reimplementing the
ed25519 on-curve test. Missing the canonical address would need all 16 candidates to be
on-curve, roughly a 1-in-65,000 event. The implementation is cross-checked against
`PublicKey.findProgramAddressSync`, which found the canonical PDA in 1,600 of 1,600 cases.

**Platinum is now reachable on a Solana-native wallet.** Hyperliquid is still EVM-only and
scores 0 here, but with the perp signal working a Solana wallet can reach 10 of 10 on age,
swaps, perps, tokens, volume and bridge alone. The earlier note about an 8-of-10 ceiling no
longer applies.

### The score cannot be forged

`slxka_create_entry` looks the score up in `slxka_wallet_scores` and ignores any score in
the request body. Verified: a request claiming `score: 10, tier: Platinum` against a stored
score of 7 recorded 7 / Gold. `anon` cannot write to that table (401), and with no stored
score the submission is refused with `score_missing`.

---

## Backend

Supabase project `dcpgnltlnkvzzwtmbpyv`, region `ap-northeast-2` (Seoul). Dedicated to this
campaign, no other client's data present. All objects prefixed `slxka_`.

Tables: `slxka_entries`, `slxka_kol_list`, `slxka_link_clicks`, `slxka_winners`,
`slxka_app_settings`, `slxka_quiz_key`, `slxka_wallet_scores`.

**Telegram is required and unique.** Winners are contacted and paid over Telegram, so
`slxka_create_entry` refuses `telegram_required` when it is missing, `bad_telegram` when it
does not match `^[A-Za-z0-9_]{4,32}$`, and `duplicate_telegram` when it is already used. It
is stored with any leading `@` stripped and compared case-insensitively, so `@Name`, `name`
and `NAME` are all one person and cannot be used to enter three times.

`anon` has no access to `slxka_entries` at all. Entries exist only via the scoped RPC.
`slxka_claim_bonus` adds exactly +5, once, on a still-pending row, and can never touch
`status`. `slxka_admin_stats` is `authenticated` only.

Entries and the bonus both stop at the deadline, enforced server-side by `slxka_is_open()`.
The page mirrors it with a countdown that re-asks the server on expiry rather than
trusting the browser clock.

### Admin

`/#admin`, Supabase Auth.

- `admin+slxka@holohive.io`
- Password: **rotate before launch.** The temporary password was shared in the build
  session. Store the new one in the campaign credential note.

---

## Known state

**Trading volume is still simulated.** The Superluminal volume API does not exist yet. The
client reports a figure, stored as `reported_volume` with `volume_verified = false`, and
the band is computed from it server-side. A user can inflate their own entry count.
Acceptable only while there is no prize. **No draw may run while rows are unverified** —
`slxka_admin_stats` returns an `unverified_volume` counter for this.

**Wallet signatures are captured, not yet verified.** `wallet_msg` and `wallet_sig` are
stored on every entry; verifying ed25519 needs an edge function. `wallet_verified` stays
false. Verify before any payout.

---

## Before you send this anywhere public

1. Set the four environment variables, especially the two Supabase ones.
2. Add the deployed domain to the Reown allowlist.
3. Rotate the admin password.
4. Get client-approved wording for quiz Q6 (the "inverted fee model" question), or remove it.
5. Correct the batch-clearing figure in the client's KOL brief; it says 40ms, the quiz says 100ms.
6. Confirm the Superluminal `ref` parameter is live so outbound traffic is attributable.
7. Set `deadline` in `slxka_app_settings` to a real KST timestamp.
8. Score a wallet you know has traded perps on Drift or Velocity and confirm `perpVenues`
   comes back non-empty. The PDA derivation is verified against `@solana/web3.js`, but the
   live match against real accounts has not been observed yet.
9. Decide whether "Drift" in the client-facing model doc should now read "Velocity".
10. Close `accepting_entries`, then reopen it deliberately at launch.

### KOL attribution

`?from=<name>`, e.g. `https://<domain>/?from=EWL`. Clicks land in `slxka_link_clicks`.
Clicks are directional only and are never reported as signups. Korean KOL content cannot
carry affiliate or referral links to a financial product, so these pass a campaign code
and nothing else.

---

Built by Holo Hive.
