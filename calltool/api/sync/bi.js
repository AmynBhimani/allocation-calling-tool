// Better Impact API client. Pages through the enterprise users endpoint with HTTP Basic auth.
// Uses global fetch (available in Node 18).

function authHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// Fetch one page of users.
async function fetchPage(base, user, pass, pageNumber, pageSize) {
  const url = `${base}?page_size=${pageSize}&page_number=${pageNumber}`
    + `&include_custom_fields=true&include_qualifications=true`
    + `&include_memberships=false&include_verified_volunteers_background_check_results=false`;
  const res = await fetch(url, { headers: { Authorization: authHeader(user, pass), Accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`BI API ${res.status} on page ${pageNumber}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// Page through all users. onBatch(users[], header) is called per page.
async function fetchAllUsers({ base, user, pass, pageSize = 250, maxPages = 250, onBatch }) {
  let page = 0, total = null, pages = 0;
  while (page < maxPages) {
    const body = await fetchPage(base, user, pass, page, pageSize);
    const header = body.Header || body.header || {};
    const users = body.Users || body.users || [];
    if (total == null) total = header.total_items_count;
    if (onBatch) await onBatch(users, header);
    pages++;
    const hasNext = header.has_next_page === true || (header.is_last_page === false);
    if (!hasNext || users.length === 0) break;
    page++;
  }
  return { pages, total };
}

module.exports = { fetchAllUsers };
