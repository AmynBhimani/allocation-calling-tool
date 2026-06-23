// Field mapping: Better Impact API user object -> normalized record.
// Separated for testability (so the custom-field / qualification matching can be unit-tested).

const REGIONS = ["BC", "Prairies", "Edmonton"];

const WESTERN_JKS = new Set([
  "BC - Burnaby Lake","BC - Chilliwack/Abbotsford","BC - Darkhana","BC - Downtown",
  "BC - Fraser Valley","BC - Headquarters","BC - Kelowna","BC - Nanaimo","BC - Richmond",
  "BC - Tri-City","BC - UNBC Campus JK","BC - Victoria",
  "Edmonton - Fort McMurray","Edmonton - North","Edmonton - Red Deer","Edmonton - South","Edmonton - West",
  "Prairies - Franklin","Prairies - Generations Calgary","Prairies - Headquarters","Prairies - Lethbridge",
  "Prairies - Northwest","Prairies - Regina","Prairies - Saskatoon","Prairies - South",
  "Prairies - Westwinds","Prairies - Winnipeg"
]);

const AREA_KEYS = {
  "Food Services": "food service and refreshments",
  "Layout & Logistics": "layout, installation and logistics",
  "Medical Services": "medical services",
  "Parking & Transportation": "parking and transportation",
  "Reception & Hospitality": "reception and hospitality",
  "Registration & Access": "registration and access",
  "Safety & Flow Management": "safety and flow management",
  "Seniors & Mobility": "seniors and mobility support",
};

function ageFromBirthday(b) {
  if (!b) return null;
  const d = new Date(b); if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a;
}
const yes = v => String(v == null ? "" : v).trim().toLowerCase() === "yes" || v === true;

function normalize(u) {
  const cfs = u.custom_fields || u.customFields || [];
  const quals = u.qualifications || [];
  const cfVal = name => {
    const n = String(name).toLowerCase();
    const c = cfs.find(c => String(c.custom_field_name || c.name || "").toLowerCase().includes(n));
    return c ? c.value : null;
  };
  const hasQual = kw => quals.some(q => String(q.qualification_name || q.name || "").toLowerCase().includes(kw));

  const jkRaw = cfVal("ceremony jamatkhana");
  const jk = jkRaw ? String(jkRaw).trim() : null;

  const areas = {};
  for (const [canon, kw] of Object.entries(AREA_KEYS)) areas[canon] = yes(cfVal(kw));

  return {
    user_id: u.user_id,
    first: u.first_name || "", last: u.last_name || "",
    email: u.email_address || "",
    cell_phone: u.cell_phone || "", home_phone: u.home_phone || "", work_phone: u.work_phone || "",
    username: u.username || "",
    jk,
    birthday: u.birthday || null,
    age: ageFromBirthday(u.birthday),
    interfaith: yes(cfVal("inter-faith family member")),
    healthcare: yes(cfVal("healthcare professional or provider")),
    medical_conditions: yes(cfVal("physical/ medical conditions")) || yes(cfVal("medical conditions that affect")),
    cert_firstaid: hasQual("first aid"),
    cert_foodsafety: hasQual("food safety"),
    cert_acls: hasQual("advanced cardiovascular") || hasQual("acls"),
    cert_mhfa: hasQual("mental health first aid"),
    happy_anywhere: yes(cfVal("happy to volunteer in any area")),
    areas,
  };
}

module.exports = { normalize, ageFromBirthday, yes, WESTERN_JKS, AREA_KEYS, REGIONS };
