// Allocation engine (ported from the Python build). Pure function over normalized records.
// A normalized record:
// { user_id, first, last, email, age, jk,
//   interfaith:bool, healthcare:bool, medical_conditions:bool,
//   cert_firstaid:bool, cert_foodsafety:bool, cert_acls:bool, cert_mhfa:bool,
//   areas:{<canonicalAreaName>:bool}, happy_anywhere:bool }

const AREA_PRIORITY = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services", "Environmental Sustainability"
];

function regionOf(jk) {
  return jk && jk.includes(" - ") ? jk.split(" - ")[0].trim() : (jk || "").trim();
}

// LIST / category (precedence, first match)
function listOf(r) {
  if (r.interfaith) return "IFF";
  if (r.age != null && r.age < 13) return "Young";
  if (r.age != null && r.age > 64) return "Seniors";
  if (r.medical_conditions) return "DA";
  return "Jamatkhana";
}

// BASE area (before the young-volunteer family override)
function baseArea(r) {
  const anyHealthCert = r.cert_firstaid || r.cert_acls || r.cert_mhfa;
  if (r.healthcare || anyHealthCert) return "Medical Services";   // Medical always wins
  if (r.cert_foodsafety) return "Food Services";                  // Food next
  const selected = AREA_PRIORITY.filter(a => r.areas && r.areas[a]); // real areas, in priority order
  if (selected.length === 0) return null;                          // held aside
  if (selected.length === 1) return selected[0];
  return selected[0];                                              // 2+ -> first in priority order
}

// Run the full engine over a batch (needed for the young-volunteer email-family rule)
function allocate(records) {
  // 1) base areas
  const base = new Map();
  for (const r of records) base.set(r.user_id, baseArea(r));

  // 2) email -> members (for young inheritance)
  const byEmail = new Map();
  for (const r of records) {
    const e = (r.email || "").toLowerCase().trim();
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(r);
  }

  const out = [];
  for (const r of records) {
    let area = base.get(r.user_id);
    // 3) young-volunteer override: under-13 inherits the OLDEST email-sharer's base area
    if (r.age != null && r.age < 13) {
      const e = (r.email || "").toLowerCase().trim();
      const sharers = (e && byEmail.get(e) || []).filter(x => x.user_id !== r.user_id);
      if (sharers.length === 0) {
        area = null; // no anchor -> held aside
      } else {
        const oldest = sharers.reduce((a, b) => ((b.age || -1) > (a.age || -1) ? b : a));
        area = base.get(oldest.user_id); // inherit (may itself be null)
      }
    }
    out.push({
      user_id: r.user_id,
      region: regionOf(r.jk),
      list: listOf(r),
      computed_area: area,
      held_aside: area == null
    });
  }
  return out;
}

module.exports = { allocate, regionOf, AREA_PRIORITY };
