# Superluminal Korea Activation

Community activation site. Single-file static frontend, Supabase backend, deployed on Vercel.

**Status: NOT LAUNCHED.** `accepting_entries` is `false`. Do not distribute any link
to KOLs or the client GC until the audit returns a pass. See "Before launch" below.

---

## Deploy

```bash
# 1. create the repo (private, Holo-Hive org)
git init
git add .
git commit -m "Superluminal Korea Activation: initial build"
git branch -M main
git remote add origin git@github.com:Holo-Hive/superluminal-korea-activation.git
git push -u origin main
```

Then in Vercel:

1. **Add New → Project → Import** the repo, under team **holo-hive**.
2. Framework preset: **Other**. No build command, no output directory, no install command.
   It is a static single file; Vercel serves `index.html` directly.
3. Deploy. `vercel.json` applies the security headers and CSP automatically.
4. Enable **Web Analytics** and **Speed Insights** in the project settings.
5. Do **not** attach a custom domain yet. That happens after the audit passes, so
   nothing indexable exists early.

No environment variables are needed. The only key in the client is the Supabase
publishable key, which is public by design.

---

## What is in here

| File | Purpose |
|---|---|
| `index.html` | The entire site. Inline CSS and JS, no build step, images inlined as base64. |
| `vercel.json` | Clean URLs, cache headers, HSTS, X-Frame-Options, nosniff, CSP. |
| `supabase/MIGRATIONS.md` | How to pull and re-apply the database schema. |

### The three config blocks

Everything variable lives near the top of `index.html`:

1. **`:root` CSS custom properties** — every colour, font and radius. No hex codes elsewhere.
2. **`CONFIG`** — Supabase URL and publishable key, Reown project id, quality gate, bands, network.
3. **`STRINGS`** — every user-facing string in EN and KO, keyed once. Korean was produced
   through the `kr-localization` skill; do not machine-translate edits.

---

## Backend

Supabase project `hqobmhvmgbzphhzeymvl`, all objects prefixed `slxka_`.

Tables: `slxka_entries`, `slxka_kol_list`, `slxka_link_clicks`, `slxka_winners`,
`slxka_app_settings`, plus `slxka_quiz_key` (the quiz answer key, never client-readable).

**The security boundary.** `anon` has no access to `slxka_entries` at all. Entries are
created only through `slxka_create_entry`, a `SECURITY DEFINER` RPC that:

- refuses unless `slxka_is_open()` returns open (gate **and** deadline)
- verifies the quiz server-side against `slxka_quiz_key`, so an edited client cannot fake a pass
- requires a connected wallet plus an ed25519 ownership signature
- validates the wallet is base58 SVM format, rejects EVM `0x` addresses
- rejects duplicate handle and duplicate wallet
- computes the band and entry count server-side, so entry counts cannot be forged

`slxka_claim_bonus` adds exactly +5, once, only on a still-pending row, and can never
touch `status`. `slxka_admin_stats` is `authenticated` only.

### Admin

`/#admin` on the deployed site. Sign in with the Supabase Auth admin user.

- User: `admin+slxka@holohive.io`
- Password: **rotate before launch.** The temporary password was shared in the build
  session and must not survive into production. Store the new one in the campaign
  credential note, never in a group chat.

---

## Known state, read before touching anything

**Volume is simulated.** The Superluminal volume API does not exist yet. The client
reports a volume, the server stores it as `reported_volume` with `volume_verified = false`,
and computes the band from it. A user can inflate their own entry count. This is
acceptable only because there is no prize in this phase.

**No draw may run while `volume_verified = false`.** `slxka_admin_stats` returns an
`unverified_volume` counter for exactly this reason.

**Wallet quality score is simulated.** The Silver gate (score >= 5) is enforced
server-side, but the score it judges is currently generated in the browser. Real
scoring needs the Helius / Solscan / Drift / Birdeye calls from the Wallet Quality
Verification model, and those keys must live server-side, not in `index.html`.
Rows carry `score_verified = false` until that lands.

**Wallet signatures are captured, not yet verified.** `wallet_msg` and `wallet_sig`
are stored on every entry. Verifying the ed25519 signature needs an edge function.
Rows carry `wallet_verified = false`. Verify before any payout.

---

## Before launch

Blocking:

1. **Move to a dedicated Supabase project.** This project also hosts the live Tria Fit
   Check campaign, so the publishable key shipped here reaches another client's data.
   This is the one open Critical from the audit.
2. Rotate the admin password.
3. Get client-approved wording for quiz Q6, or remove the question.
4. Correct the batch-clearing figure in the client's KOL brief (it says 40ms, the quiz says 100ms).
5. Confirm the Superluminal ref parameter is live, so outbound traffic is attributable.
6. Set `deadline` in `slxka_app_settings` to a real KST timestamp.
7. Add the deployed domain to the allowlist on the Reown project.

Then, and only then, in this order: flip `accepting_entries` to `'true'`, attach the
custom domain, distribute KOL links.

### KOL attribution

Each KOL gets `?from=<name>`, for example `https://<domain>/?from=EWL`. Clicks land in
`slxka_link_clicks`. Clicks are directional only and are never reported as signups.
Korean KOL content cannot carry affiliate or referral links to a financial product, so
these links pass a campaign code and nothing else.

---

Built by Holo Hive.
