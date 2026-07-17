// Declared-distinct pairs: "the scan thinks these two are the same person; a human looked and they
// are not." Two accounts can look identical to every heuristic we have — same name, same phone, same
// Jamatkhana — and still be two people (father and son is the usual one). Only a human who checked
// Better Impact can settle it, so this module stores that decision and hands it to the scan.
//
// WHY ITS OWN BLOB, not a flag on the records: biupsert re-creates a record for any live BI account
// it can't find, so anything written onto the record is refreshed away. That is the same trap that
// makes both_in_bi necessary. Keyed by BI id in a blob nothing else writes, the decision survives
// every refresh. The pair is the unit — never one record — because "distinct" is a statement ABOUT a
// relationship, and A being distinct from B says nothing about A and C.
//
// The declaration is reversible on purpose: undoing only makes the pair appear on the screen again.
const { streamToString } = require("./store");

const BLOB = "distinct-pairs.json";

// Unordered pair -> one stable key. Sorted as STRINGS: BI ids are numeric but write-in ids are
// "wi-..." and both flow through here, so numeric sort would not be total.
const pairKey = (a, b) => {
  const x = String(a), y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
};

// Every declaration as a Set of pair keys — the shape findDuplicateClusters consumes.
const pairSet = (decls) => new Set((Array.isArray(decls) ? decls : []).map(d => pairKey(d.a, d.b)));

async function readDeclarations(container) {
  try {
    const b = container.getBlockBlobClient(BLOB);
    if (!(await b.exists())) return { decls: [], etag: null };
    const dl = await b.download();
    const parsed = JSON.parse(await streamToString(dl.readableStreamBody));
    if (!Array.isArray(parsed)) return { decls: [], etag: null };   // never let a bad blob wedge the screen
    return { decls: parsed, etag: dl.etag };
  } catch {
    return { decls: [], etag: null };
  }
}

// etag -> If-Match, so two iVol admins declaring at once can't lose one another's write.
// No etag -> the blob did not exist; If-None-Match:* so only the first creator wins.
async function writeDeclarations(container, decls, etag) {
  const b = container.getBlockBlobClient(BLOB);
  const body = JSON.stringify(decls);
  const opts = { blobHTTPHeaders: { blobContentType: "application/json" } };
  if (etag) opts.conditions = { ifMatch: etag };
  else opts.conditions = { ifNoneMatch: "*" };
  await b.upload(body, Buffer.byteLength(body), opts);
}

const sameDecl = (d, a, b) => pairKey(d.a, d.b) === pairKey(a, b);

// Read-modify-write with a retry, because the whole file is one blob and the etag is the only guard.
// Returns { ok, decls, added|removed, reason }.
async function declare(container, { a, b, region, actor, note, names }, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { decls, etag } = await readDeclarations(container);
    if (decls.some(d => sameDecl(d, a, b))) return { ok: true, decls, added: false, reason: "already_declared" };
    const next = decls.concat([{
      a: String(a), b: String(b), region: region || "", actor: actor || "", note: note || "",
      names: Array.isArray(names) ? names.slice(0, 2) : [], ts: new Date().toISOString(),
    }]);
    try {
      await writeDeclarations(container, next, etag);
      return { ok: true, decls: next, added: true };
    } catch (e) {
      if (attempt === retries) return { ok: false, reason: "conflict" };
      await new Promise(r => setTimeout(r, 60 * (attempt + 1) + Math.random() * 100));
    }
  }
  return { ok: false, reason: "conflict" };
}

async function undeclare(container, { a, b }, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { decls, etag } = await readDeclarations(container);
    const next = decls.filter(d => !sameDecl(d, a, b));
    if (next.length === decls.length) return { ok: true, decls, removed: false, reason: "not_declared" };
    if (!etag) return { ok: true, decls, removed: false, reason: "not_declared" };   // no blob = nothing to remove
    try {
      await writeDeclarations(container, next, etag);
      return { ok: true, decls: next, removed: true };
    } catch (e) {
      if (attempt === retries) return { ok: false, reason: "conflict" };
      await new Promise(r => setTimeout(r, 60 * (attempt + 1) + Math.random() * 100));
    }
  }
  return { ok: false, reason: "conflict" };
}

module.exports = { BLOB, pairKey, pairSet, readDeclarations, writeDeclarations, declare, undeclare };
