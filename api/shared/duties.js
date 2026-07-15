// Duty catalog helpers shared by api/duties (the catalog screen) and api/sessionduties (the
// per-session roster import). Duplicate detection lives here ONCE: the import is exactly where
// near-duplicate duties would flood in from thirteen separately-filled templates, so it must apply
// the same rule the catalog screen already applies.

const AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services", "Diverse Abilities Support",
  "Finance & Procurement", "Environmental Sustainability", "Memorabilia & Design", "Jamati Preparation",
];

const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();

// A duty is a likely duplicate of an existing one (same area) when the NAME matches, or the
// DESCRIPTION matches when both are non-empty — catches "Driver" vs "Bus Driver".
function dupOf(existing, d) {
  for (const x of (existing || [])) {
    if (clean(x.area) !== clean(d.area)) continue;
    if (norm(x.name) === norm(d.name)) return { match: x, field: "name" };
    if (norm(x.description) && norm(x.description) === norm(d.description)) return { match: x, field: "description" };
  }
  return null;
}

// Exact catalog hit on area + name (case-insensitive). Identity of a duty is area + name.
function findDuty(catalog, area, name) {
  return (catalog || []).find(x => clean(x.area) === clean(area) && norm(x.name) === norm(name)) || null;
}

const dutiesForArea = (catalog, area) =>
  (catalog || []).filter(x => clean(x.area) === clean(area))
    .sort((a, b) => clean(a.name).localeCompare(clean(b.name)));

module.exports = { AREAS, clean, norm, dupOf, findDuty, dutiesForArea };
