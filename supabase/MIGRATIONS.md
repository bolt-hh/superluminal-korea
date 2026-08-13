# Database schema

Project **dcpgnltlnkvzzwtmbpyv**, region `ap-northeast-2` (Seoul). Dedicated to this
campaign. All objects prefixed `slxka_`. No other client's data is present.

## Applied migrations

| Name | What it does |
|---|---|
| `slxka_01_tables_and_rls` | Seven tables, RLS enabled on all, policies. `anon` has no access to `slxka_entries`. |
| `slxka_02_rpcs` | Band maths, tier ladder, quiz verification, `slxka_is_open` deadline gate, create entry, claim bonus, resume, stats, seeds. |

Seeds: `accepting_entries`, `deadline`, `winners_published`, `quality_gate`,
`volume_source`; KOL `EWL`; the 7-row quiz answer key.

## Pull the SQL into the repo

```bash
supabase link --project-ref dcpgnltlnkvzzwtmbpyv
supabase db pull
git add supabase/migrations && git commit -m "capture schema"
```

## History

Built first into `hqobmhvmgbzphhzeymvl` (`tria-fit-check`) because the org was at its
2-active-free-project limit. That project auto-paused on 13 Aug 2026, taking the backend
offline and confirming the coupling risk. A slot freed up, so the schema was rebuilt here
as a dedicated project. This closed audit finding C1. The old `slxka_` tables in
`tria-fit-check` are orphaned and should be dropped when that project is next resumed:

```sql
drop table if exists public.slxka_entries, public.slxka_kol_list, public.slxka_link_clicks,
  public.slxka_winners, public.slxka_app_settings, public.slxka_quiz_key,
  public.slxka_wallet_scores cascade;
drop function if exists public.slxka_create_entry(jsonb), public.slxka_claim_bonus(text,text),
  public.slxka_find_code(text), public.slxka_identity_taken(text), public.slxka_public_stats(),
  public.slxka_admin_stats(), public.slxka_verify_quiz(int[]), public.slxka_gen_ref(),
  public.slxka_is_open(), public.slxka_band_for(numeric), public.slxka_band_entries(int),
  public.slxka_calc_entries(boolean,numeric,boolean), public.slxka_tier_for(numeric) cascade;
```

## Creating the admin user by SQL

GoTrue returns a 500 "Database error querying schema" if the token columns on `auth.users`
are NULL. Set `confirmation_token`, `recovery_token`, `email_change_token_new`,
`email_change`, `email_change_token_current`, `phone_change`, `phone_change_token` and
`reauthentication_token` to empty strings, and create the matching `auth.identities` row.

## Verification queries

As `anon`, all verified on this project:

- `select * from slxka_entries` returns nothing even when rows exist
- direct insert / update / delete on `slxka_entries` denied
- `select * from slxka_quiz_key` returns nothing
- `slxka_admin_stats()` raises `forbidden`
- insert into `slxka_wallet_scores` returns 401, so scores cannot be forged
- `slxka_create_entry` refuses on: gate closed, deadline passed, wrong quiz, missing wallet,
  missing signature, EVM address, duplicate handle, duplicate wallet, and `score_missing`
  when no server-computed score exists
- a request claiming score 10 / Platinum against a stored 7 records 7 / Gold
- `slxka_claim_bonus` twice on one ref: the second call refuses
