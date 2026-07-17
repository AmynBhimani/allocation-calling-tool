// The event date, and how old someone is ON it.
//
// This exists because two separate gates decide eligibility and they MUST agree:
//   - the AREA allocation (alloc.js -> eligible(age, target)), which enforces an area's age window
//   - the DUTY allocation (dutyalloc.js), which enforces a duty's stricter minimum age
//
// Both must measure age against the EVENT DAY, not today. Someone born 21 July 2007 is 18 today and
// 19 on 23 July 2026: measure against today and the app will place them into a 19+ area (correct —
// they'll be 19 on the day) and then refuse them a 19+ duty inside it. Same person, same day, two
// answers. Keeping the constant and the function in one place is what makes that impossible.
//
// NOTE the seven ageOf() copies across api/accepted, api/calls, api/volunteers, api/assign,
// api/volunteer, api/allvolunteers and api/shared/dedup all measure against TODAY. That is right for
// a screen showing someone's age now, and wrong for eligibility. Do not use them for a gate.
//
// AS_OF is deliberately one date, not one per session: sessions carry no date field (their titles
// do, by decision), so a 24 July volunteer and a 26 July volunteer are both measured at 23 July.
// It is conservative by 1-3 days — someone turning 19 on 25 July reads as 18. Accepted knowingly.
const AS_OF = "2026-07-23";

function ageAsOf(birthday, asOf) {
  if (!birthday) return null;
  const d = new Date(birthday); if (isNaN(d)) return null;
  const ref = new Date(asOf);
  let a = ref.getFullYear() - d.getFullYear();
  const m = ref.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < d.getDate())) a--;
  return a;
}

// A directly-set age wins over a birthday — same precedence the area allocation has always used.
const ageOfOn = (v, asOf) => (v && v.age != null && Number.isFinite(Number(v.age)))
  ? Number(v.age) : ageAsOf(v && v.birthday, asOf || AS_OF);

module.exports = { AS_OF, ageAsOf, ageOfOn };
