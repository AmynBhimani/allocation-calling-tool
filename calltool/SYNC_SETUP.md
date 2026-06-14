# Better Impact Sync — setup & first run

The sync pulls all enterprise users from Better Impact, filters to the 27 Western Ceremony
Jamatkhanas, recomputes allocation with the validated engine, and upserts into storage. It is
**Super-Admin only**.

## App settings to add (SWA → Settings → Environment variables)

| Name | Value |
|------|-------|
| `BI_API_USER` | the API key **username** from Better Impact |
| `BI_API_PASS` | the API key **password** from Better Impact |
| `BI_API_BASE` | *(optional)* defaults to `https://api.betterimpact.com/v1/enterprise/users/` |

Save, then give the API ~30 seconds to restart.

## First run — ALWAYS dry-run first

The sync defaults to a **dry run** that writes to a throwaway container (`tool-data-dryrun`), so it
never touches the live reconciliation data until you've eyeballed the output.

1. Signed in as Super Admin, open in the browser:
   `https://<your-host>/api/sync`  (no parameter = dry run)
2. It returns a JSON summary. Check:
   - `biTotal` ≈ 25,500 (the whole enterprise was scanned) and `scanned` matches it
   - `western` ≈ 9,043 (the 27-JK filter worked)
   - `byStatus` shows ~7,400 Stable + ~1,550 Unassigned
   - `byArea` roughly matches: Safety ~2,100, Reception ~2,000, Medical ~1,200, Food ~890, etc.
   - `byRegion`: BC ~3,235 · Prairies ~4,032 · Edmonton ~1,776
3. If those look right, **commit**:
   `https://<your-host>/api/sync?mode=commit`
   This writes to the real `tool-data` and **preserves call state** — any volunteer Armaan's team has
   already reconciled, or who's been assigned/called, keeps their final area, status, and history;
   only contact details and the recomputed area refresh.

## What the summary tells you
- `added` — brand-new volunteers this run
- `preserved` — existing volunteers whose reconciliation/call state was kept untouched
- `refreshed` — existing untouched volunteers fully recomputed
- `elapsed_ms` — how long the pull took (first full pull is the slow one)

## Sanity check if numbers look off
- `western` only a few hundred (not ~9,000): the API key is scoped to one organization, not the
  enterprise — recreate it from an admin account with enterprise visibility, Volunteer module checked.
- `biTotal` is null / error about qualifications: the key is missing the **Volunteer** module.
- A 401/403 from BI: `BI_API_USER` / `BI_API_PASS` are wrong or the key isn't **Enabled**.

## Not wired yet (by design)
- The review-tool flag join (affinity / leader / conflict) — every synced volunteer currently comes in
  as `never_reviewed: true` with those flags false. We layer those on via the crosswalk as a separate
  step once the review results are exported.
- The held-aside / new-registrant allocation rule (the ~1,550 Unassigned) — rules still TBD with you.
