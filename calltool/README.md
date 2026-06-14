# VE Allocation & Calling Tool

Internal tool for the Western Visit volunteer **reconciliation** and **calling** phases. Separate
Azure Static Web App from the review tool, on the same stack (Functions + Blob + External ID).

This package is the **foundation build (steps 1–2)**: sign-in, the five-role model, storage, and the
Duty Allocation Team **reconciliation screen**, running against a bundled **sandbox dataset** (415
synthetic volunteers) so it is fully testable before the Better Impact sync exists.

See **DEPLOYMENT.md** for setup. Architecture in brief:

- **Roles** (`/api/roles`): `superadmin` (from `SUPER_ADMIN_EMAILS`), and `admin` / `dutyteam` /
  `quarterback` / `caller` from a role store blob. Routes gate on these custom roles — never the
  built-in `authenticated` (the security lesson from the review tool).
- **Volunteers** (`/api/volunteers`): GET returns reconciliation rows **without contact details**
  (scoped-access principle); POST sets a volunteer's final area and flips their callable status.
  Data is sharded by region (`tool-data/volunteers-{region}.json`).
- **Seed** (`/api/seed`): Super-Admin-only, loads the bundled sandbox data.
- **Ping** (`/api/ping`): health check; returns the Node version.

Callable status drives the parallel-calling model: setting a final area makes **that volunteer**
callable immediately, without releasing a whole area.
