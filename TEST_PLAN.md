# VE Allocation & Calling Tool — Test Plan

Run these in order. Each section is a piece we've shipped. Check items off; note anything that
doesn't behave as described. New sections get added as we build (quarterback, calling, etc.).

Legend: ☐ = to test. Sign in as your **Super Admin** email unless a step says otherwise.

---

## A · Role Management (Team & Roles screen)

**Access**
- ☐ Signed in as Super Admin, the **Team & Roles** link shows in the header. Open it.
- ☐ (If you can sign in as a non-admin email) `/admin.html` should bounce you — not load the page.

**Adding each role type**
- ☐ Add an email as **Admin** → no region/area required; appears under Admin.
- ☐ Add an email as **Duty Allocation Team**, region BC → appears with "BC".
- ☐ Add an email as **Quarterback** → it should *force* region + area (try without → refused).
- ☐ Add an email as **Caller**, region + area → appears correctly.

**Validation (all should be refused politely)**
- ☐ Malformed email ("notanemail") → refused.
- ☐ Exact same person + role + scope twice → refused as duplicate.
- ☐ No way to add a Super Admin here (by design).

**Removal & persistence**
- ☐ Remove an assignment → it disappears, count drops.
- ☐ Refresh the page → remaining people are still there (saved to storage).
- ☐ A newly-added person's role only takes effect after they sign out/in (roles stamp at login).

---

## B · Data load (Seed)

- ☐ On the reconciliation screen, as Super Admin you see **Load sandbox data** (top right).
- ☐ Click it → banner confirms ~415 loaded; the table fills.
- ☐ Refresh → data persists (it's in storage, not just on screen).

---

## C · Reconciliation screen (Armaan's tool)

**View & filters**
- ☐ KPI cards show counts: Total, Stable, In reconciliation, Unassigned, Leadership.
- ☐ Region filter narrows the list; the **Jamatkhana** dropdown narrows to that region's JKs.
- ☐ Each chip works: Needs decision, Unassigned, Leadership, Conflicts, Leaders, New.
- ☐ Name search filters.

**Setting a final area (the core action)**
- ☐ Pick a Final area for an "In reconciliation" or "Unassigned" volunteer → status flips to
  **Stable · callable**, the KPI counts update, the row flashes.
- ☐ Refresh → the change persisted.
- ☐ Set a volunteer to **Hold aside** → status becomes Unassigned.

**Leadership – Do Not Allocate (new)**
- ☐ On any volunteer, choose **⚑ Leadership – Do Not Allocate** from the Final-area dropdown →
  status becomes **Leadership · do not allocate**, row tints, KPI "Leadership" increments.
- ☐ The **Leadership** chip filters to exactly those people.
- ☐ Refresh → it persisted.
- ☐ On a Leadership volunteer, pick a real area → they leave Leadership and become Stable again.

---

## D · Concurrency / robustness (quick sanity, optional)

You don't need to simulate 40 users, but you can confirm the safety behaviour:
- ☐ Open the reconciliation screen in **two browser windows** (both as you).
- ☐ In window 1, set volunteer X's area. In window 2 (without refreshing), set volunteer Y's area.
- ☐ Refresh both → **both** changes are present. (Before the re-architecture, one could have been
  lost — the storage layer now prevents that.)

---

## E · Better Impact sync (blocked on the API key)

Can't run until BI enables the key. When it's live (`bitest.py` returns 200):
- ☐ Add `BI_API_USER` / `BI_API_PASS` app settings; wait ~30s.
- ☐ `/api/sync` (dry run) → summary shows biTotal ~25,500, western ~9,043, ~7,400 Stable /
  ~1,550 Unassigned, areas roughly Safety ~2,100 / Reception ~2,000 / Medical ~1,200 / Food ~890.
- ☐ If correct, `/api/sync?mode=commit` → writes real data, preserving any reconciliation already done.

---

## Health checks (any time something seems off)
- ☐ `/api/ping` → JSON with `node: v18.x` (API host healthy).
- ☐ `/.auth/me` → `userRoles` includes `superadmin` (and any roles you've been granted).

---

## F · Quarterback Assignment screen

Set up first (as Super Admin, in Team & Roles): add a **Quarterback** for an area × region that has
callable volunteers (e.g. Reception & Hospitality · BC). Then sign in as that quarterback (or use the
**Assignment** link as Super Admin).

**The pool**
- ☐ The screen shows only **Stable/callable** volunteers whose **final area** is in your scope, in
  your region. (Not In-reconciliation, Unassigned, or Leadership; not other areas.)
- ☐ KPI cards: In your pool / Assigned / Unassigned.
- ☐ If you own multiple areas, the **Viewing** dropdown filters to one area × region.
- ☐ Filters work: JK (within scope), Team Leads, New, and the Unassigned/Assigned chips.
- ☐ Name search works.

**Adding your own callers**
- ☐ Click **+ Add a caller** → enter an email, tick one or more of *your* areas → Add.
- ☐ The caller appears in the **Choose a caller…** dropdown.
- ☐ (Scope check) You only see your own areas to assign the caller to — not others.

**Assigning (hand-pick)**
- ☐ Tick a few volunteers → the action bar shows the count.
- ☐ Pick a caller → **Assign** → those rows show the caller's email under "Assigned to."
- ☐ Refresh → assignments persisted.

**Assigning (bulk)**
- ☐ Filter to a batch (e.g. unassigned Team Leads from one JK) → **Select all filtered** →
  Assign to a caller in one go.
- ☐ The "Unassigned" KPI drops by the batch size.

**Unassign / reassign**
- ☐ Select assigned volunteers → **Unassign** → they return to unassigned.
- ☐ Assign already-assigned volunteers to a different caller → the caller updates.

**Boundaries**
- ☐ A quarterback only ever sees their own area × region pool (not the whole region).
- ☐ As Super Admin, the **Assignment** screen shows the full pool (you can act for any area).

---

## G · Caller call screen

Set up: as a quarterback (or Super Admin via Assignment), assign a few volunteers to a caller email,
including one flagged **No BI acct**. Then sign in as that caller (or use **My Calls** as Super Admin).

**Queue**
- ☐ "To call" tab lists your assigned volunteers; count matches.
- ☐ A **No BI acct** volunteer shows the red badge in the list.
- ☐ Click someone → the call panel opens with their name, area, JK.

**The call panel**
- ☐ Contact info (cell, email) shows and is **editable**; only for your own assignments.
- ☐ A **No BI account** person shows the "⚑ set them up" alert.
- ☐ Notes box + six outcome buttons appear.

**Outcomes**
- ☐ **No answer** → logs an attempt, the person **stays** in "To call" (now showing "last: No answer").
- ☐ **Thinking about it** → optional follow-up date; **stays** in queue.
- ☐ **Accepted** → leaves "To call", appears in **Completed**.
- ☐ **Withdrew** → leaves, appears in Completed.
- ☐ **Decline → refer** → pick an area → confirm → leaves your queue.

**Referral handoff**
- ☐ As the **receiving area's** quarterback, the referred person appears in that pool,
  unassigned, with a "Referred from …" badge — ready to assign to a caller there.

**Completed view**
- ☐ The **Completed** tab shows your finished calls (incl. referred-away ones, labelled with the
  outcome you logged), read-only, with the call history.

**Boundaries**
- ☐ A caller only sees their own assigned people (not the whole area).
- ☐ Contact details never appear on the reconciliation or assignment screens — only here.

---

## H · Backup (do this BEFORE any sync change)

- ☐ As Super Admin, the **Download backup** link appears in the reconciliation header.
- ☐ Click it → a `volunteer-backup-<timestamp>.json` file downloads to your computer.
- ☐ Open it → it contains all three regions and a total count. Keep it somewhere safe.
- ☐ (Recommended, one-time in Azure) Storage account → Data protection → enable **soft delete**
  for blobs and **versioning**, so overwrites are recoverable automatically.

---

## I · iVol Input Report

Set up: have at least one volunteer a caller marked **Accepted** or **Negotiated** (Sequence G).
Sign in as Super Admin or Admin → header link **iVol report**.

- ☐ The report lists people ready for Better Impact entry: name, username, region, committee,
  outcome, accepted date. (Pending-only by default.)
- ☐ KPI cards: Pending entry / Entered in BI.
- ☐ Tick a few rows (or **select-all**) → **Mark entered in BI** → they get a ✓ and leave the
  pending list.
- ☐ Turn on **Show already-entered too** → the entered ones reappear (with ✓).
- ☐ Select an entered person → **Undo entered** → they return to pending.
- ☐ **Export to Excel** → an `ivol-input-<date>.csv` downloads; opens in Excel with the committee
  column and identifying fields. (Opens cleanly in Excel; full field list can be expanded once the
  iVol Lead finalizes it.)
- ☐ Filters work: name search, Region, Committee, Jamatkhana (narrows to the chosen region),
  and Outcome (Accepted/Negotiated). Filters combine.
- ☐ **Export to Excel** exports exactly the filtered rows currently shown.
- ☐ **Select all** selects the filtered set (so you can mark one committee's batch at a time).
- ☐ A caller/quarterback cannot reach `/ivol.html` or `/api/ivolreport` (admin-only).

---

## J · New areas (Finance & Procurement, Environmental Sustainability)

- ☐ On Armaan's reconciliation screen, the Final-area dropdown now lists both new areas.
- ☐ A sync/file-import never *routes* anyone to them (they only appear when someone is placed there
  via reconciliation override or the affinity import).
- ☐ A quarterback/caller can be scoped to them in Team & Roles; a caller can refer into them.

## K · Duties management (Super Admin / Admin / Quarterback)

Header link **Duties**.
- ☐ Add a duty: pick an Area, enter Duty Name + Description → it appears under that area.
- ☐ As a quarterback, only *your* areas appear in the Area dropdown; you can't add to others.
- ☐ Bulk upload: a CSV/Excel with columns **Area of Interest, Duty Name, Duty Description** →
  "Upload duties" → reports added / duplicates / out-of-scope / invalid.
- ☐ Remove a duty (only within your areas).
- ☐ A caller cannot reach `/duties.html`.

## L · BI File Import (Super Admin)

Header link **BI import**. The manual alternative to the API sync.
- ☐ Choose the ProfileExport .xlsx → it shows rows-in-file and Western count (~9,043) with a
  per-region breakdown.
- ☐ **Dry run** → writes to the preview area; shows ~7,488 Stable / ~1,555 Unassigned and the area
  breakdown (Safety ~2,100, Reception ~2,000, Medical ~1,200, Food ~890…).
- ☐ Review, then **Commit** → writes live data. Existing reconciliation, assignments, calls, and
  no-BI-account people are preserved (not overwritten or deleted).
- ☐ Pull a **Download backup** before committing (good habit).
- ☐ A non-Super-Admin cannot reach `/fileimport.html` or `/api/fileimport`.

---

## Sequence M — Test-feedback changes (June)

**M1 · Reconcile: default to “Choose” for needs-decision**
1. As Duty Team/Admin, open Reconcile. Click the **Needs decision** chip.
2. For a volunteer in reconciliation, confirm the Final Area dropdown shows **“— choose —”** (not a pre-filled area).
3. Pick the intended area → row flashes, status flips to Stable, person becomes callable. (Selecting the computed area now always registers as a change.)
4. Confirm the **Conflicts** chip is gone (folded into Needs decision) and conflicts still appear under it.

**M2 · Header**
1. Confirm the header shows **Reconcile** (for Duty Team/Admin/Super) and **Assign Callers** (renamed from “Assignment”).
2. Admin/Super also see **BI updates** and **Dashboard**.

**M3 · Assign Callers: caller-scope enforcement**
1. As QB with two areas, add a caller scoped to only ONE of them.
2. Select volunteers from BOTH areas, choose that caller, Assign.
3. Confirm the warning names the out-of-scope count, and after assigning only the in-scope volunteers get the caller (banner: “N skipped — outside <caller>’s lists”).

**M4 · Assign Callers: filters**
1. Confirm the **New** filter is gone; **No BI acct** and **Referred** chips exist.
2. Use **Filter by caller** → only that caller’s assignments show.
3. Toggle a chip off / use **Clear filters** → list fully resets (including a stale JK after a scope change).

**M5 · Caller: outcomes + contact edits**
1. Open a call. Confirm **Negotiated is gone** (5 outcomes).
2. Edit First/Last/Cell/Email, mark **Accepted**. Confirm it saves and the note about iVol updating BI shows.
3. Only **Accepted** flows to the iVol report (Thinking/No answer stay active).

**M6 · Caller: reopen (changed mind)**
1. On the **Done** tab, open an Accepted (or Withdrew) person → **Reopen** button shows.
2. Reopen → they return to the **active** list. If they’d been entered in BI, they appear on **BI updates** as a reopen-correction.

**M7 · iVol report**
1. Confirm no rows with a blank outcome appear (only genuine Accepted).
2. **Entered in BI** KPI updates immediately after marking entries — without toggling “show already entered”.
3. Confirm the outcome dropdown is gone (redundant).

**M8 · BI Updates Needed (Admin/Super)**
1. After M5/M6, open **BI updates**: contact diffs show old → new; reopen-after-entry shows a correction flag.
2. Select rows → **Mark done in BI** → they clear.

**M9 · Dashboard (Admin/Super)**
1. Open **Dashboard**; filter by region.
2. Per area: Assigned / Called / Accepted / Declined / Pending, with a totals row. Export CSV.

**M10 · Duties**
1. Bulk-upload with a typo’d Area of Interest → rejected rows are listed by name with the bad area called out.
2. Add a duty whose **name OR description** matches an existing one in the area (e.g., “Bus Driver” with the same description as “Driver”) → it’s flagged as a possible duplicate, not silently dropped.
