# Deployment guide — VE Allocation & Calling Tool (Foundation)

This is the new Static Web App for the calling/reconciliation phase. It is **separate** from the
review tool and reuses the same proven stack: Azure Static Web Apps (Standard), Azure Functions,
Blob Storage, and the existing **volreview** External ID tenant.

Every lesson from the review-tool build is already baked into these files. The notes below call out
the spots that bit us last time so the deploy goes smoothly.

---

## What's in this repo

```
staticwebapp.config.json   ← node:18 pinned, custom-role gating from line one
index.html / app.js / styles.css   ← the reconciliation screen
unauthorized.html          ← shown to signed-in users with no role
api/
  host.json, package.json
  ping/        ← health check (GET /api/ping)
  roles/       ← assigns the 5 roles (superadmin from env, others from a role store)
  volunteers/  ← GET (reconciliation list, no PII) + POST (set final area)
  seed/        ← Super-Admin-only: loads the bundled sandbox data
```

The sandbox dataset is bundled in `api/seed/data.json`, so the tool is fully testable before the
Better Impact sync exists.

---

## Step 1 — Create the GitHub repo

1. New repo, e.g. `AmynBhimani/allocation-calling-tool`.
2. Copy all files from this package into it, preserving the folder structure.
3. **Before committing**, edit `staticwebapp.config.json` and replace **both** `REPLACE_TENANT_GUID`
   placeholders with your External ID tenant GUID `630d47b9-754d-45e1-ba64-2c1e0e0e8ea0`
   (the discovery URL uses the GUID form on **both** the subdomain and the path — this is the issuer
   fix we learned).
4. Commit and push.

## Step 2 — Create the Static Web App

1. Azure → Create resource → **Static Web App**.
2. Same subscription; resource group `volunteer-review` is fine (keeps everything together).
3. Name e.g. `allocation-calling-tool`. **Plan: Standard** (required for custom auth + roles).
4. Deployment: **GitHub** → the new repo → branch `main`.
5. Build details: **Custom** · App location `/` · Api location `api` · Output location *(blank)*.
6. Create.

## Step 3 — Fix the workflow (the two gotchas, every time)

The wizard commits a workflow that will fail the first run. Edit
`.github/workflows/azure-static-web-apps-*.yml` and make the build block exactly:

```yaml
          app_location: "/"
          api_location: "api"
          output_location: ""
          skip_app_build: true
```

`skip_app_build: true` is the one the wizard omits (no build script → error without it). Commit; the
run should go green and the log should show the API building (`Function Runtime Information`,
`Deployment Complete`).

## Step 4 — App settings (SWA → Settings → Environment variables)

| Name | Value |
|------|-------|
| `EXTERNALID_CLIENT_ID` | the **new** app registration's client ID (see Step 5) |
| `EXTERNALID_CLIENT_SECRET` | the new app registration's secret **Value** |
| `RESPONSES_STORAGE` | connection string from a storage account (you can reuse **volreviewstore**) |
| `SUPER_ADMIN_EMAILS` | your email(s), comma-separated — type carefully, no spaces |

`SUPER_ADMIN_EMAILS` is how you (the Super Admin) get in without any role store existing yet.
Storage containers (`tool-data`, `app-config`) are created automatically on first use.

## Step 5 — External ID app registration (new, for this app's hostname)

This app has its own hostname, so it needs its own redirect URI. In the **volreview** tenant →
App registrations → **+ New registration**:

1. Name: `Allocation Calling Tool`.
2. Redirect URI → platform **Web** → `https://<new-host>/.auth/login/externalid/callback`
   (get `<new-host>` from the SWA Overview once created).
3. Register. Copy the **Application (client) ID** → `EXTERNALID_CLIENT_ID`.
4. **Certificates & secrets** → New client secret → copy the **Value** immediately → `EXTERNALID_CLIENT_SECRET`.
5. **Authentication** → enable **ID tokens** (Implicit grant and hybrid flows) → Save.
6. **External Identities → User flows** → open `sign_up_and_sign_in` → **Use → Applications** →
   add this new app. (Reuses the same email-OTP flow as the review tool.)

> Tip: you can reuse the review tool's app registration instead of making a new one — just add this
> app's redirect URI to it. A separate registration is cleaner, but either works.

## Step 6 — First run

1. Incognito → `https://<new-host>/.auth/logout` → then the site → sign in with your Super Admin email.
2. You should land on the reconciliation screen with a banner prompting you to **Load sandbox data**.
3. Click it (Super-Admin-only). It seeds 415 volunteers into `tool-data`.
4. The table fills; set a **Final area** on a volunteer and watch the status flip to **Stable · callable**
   and the change persist (reload to confirm it saved).

### Quick checks if anything misbehaves
- `https://<new-host>/api/ping` → should return JSON with `node: v18.x`. If blank-500, the host isn't
  on Node 18 — confirm `"platform": { "apiRuntime": "node:18" }` is in the deployed config.
- `https://<new-host>/.auth/me` → confirm `userRoles` includes `superadmin`. If not, check
  `SUPER_ADMIN_EMAILS` matches your sign-in email exactly, then sign out and back in (roles are stamped
  at login).

---

## Adding other team members (roles)

For the foundation, roles other than Super Admin are read from a role store at
`app-config/roles.json` (Blob), shaped as:

```json
[
  { "email": "armaan@example.com", "role": "dutyteam", "region": "BC" },
  { "email": "someone@example.com", "role": "quarterback", "area": "Reception & Hospitality", "region": "BC" }
]
```

A small admin screen to manage this is part of the next build stage; for now it can be edited directly
in Storage if you want to test the `dutyteam` role. Super Admin (you) can already do everything.

## What's deliberately NOT here yet
- The Better Impact live sync (waiting on API field confirmation) — sandbox seed stands in for it.
- The quarterback/caller screens and the iVol-input report (Phase 3).
- A UI to manage the role store.
- The unified held-aside / new-registrant allocation rule (rules TBD with you).
