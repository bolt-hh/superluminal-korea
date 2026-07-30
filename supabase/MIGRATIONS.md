# Database schema

Project `hqobmhvmgbzphhzeymvl`. All Superluminal objects are prefixed `slxka_`.
No `triafc_` object is touched by any of these.

## Applied migrations, in order

| Version | Name | What it does |
|---|---|---|
| 20260730143900 | `slxka_tables_and_rls` | Five canonical tables plus `slxka_quiz_key`, RLS enabled on all six, policies |
| 20260730143941 | `slxka_rpcs` | Band maths, quiz verification, create entry, claim bonus, resume, stats |
| 20260730143956 | `slxka_seeds` | `accepting_entries=false`, `winners_published=false`, EWL, quiz answer key |
| 20260730144311 | `slxka_harden_grants_and_search_path` | Pin `search_path` on every function, strip the implicit PUBLIC grant |
| 20260730175610 | `slxka_wallet_ownership_proof` | Wallet signature columns, unique wallet index, wallet checks in create entry |
| 20260730180759 | `slxka_deadline_autoclose` | `slxka_is_open()`, deadline enforced on both create entry and claim bonus |

## Pull the SQL into this folder

The migration bodies live in the Supabase project. To bring them into the repo:

```bash
supabase link --project-ref hqobmhvmgbzphhzeymvl
supabase db pull            # writes supabase/migrations/*.sql
git add supabase/migrations && git commit -m "capture schema migrations"
```

## Moving to a dedicated project

This is the open Critical from the audit. Once a new project exists:

```bash
supabase link --project-ref <new-ref>
supabase db push            # replays the six slxka_ migrations in order
```

Then recreate the admin Auth user, and update `SUPABASE_URL` and `SUPABASE_ANON_KEY`
in the `CONFIG` block of `index.html`, plus the Supabase origin in the CSP in `vercel.json`.

Note on creating the admin user by SQL: GoTrue fails with a 500 "Database error querying
schema" if the token columns on `auth.users` are NULL. Set `confirmation_token`,
`recovery_token`, `email_change_token_new`, `email_change`, `email_change_token_current`,
`phone_change`, `phone_change_token` and `reauthentication_token` to empty strings, and
create the matching `auth.identities` row.

## Verification queries

Run these after any re-provision, as the `anon` role, before wiring the site:

- `select * from slxka_entries` returns no rows even when rows exist
- direct `insert` / `update` / `delete` on `slxka_entries` are denied
- `select * from slxka_quiz_key` returns nothing
- `slxka_admin_stats()` raises permission denied
- `slxka_create_entry` refuses: gate closed, wrong quiz, score below 5, missing wallet,
  missing signature, EVM address, duplicate handle, duplicate wallet, past deadline
- `slxka_claim_bonus` twice on one ref: the second call refuses
