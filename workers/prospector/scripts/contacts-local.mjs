// Look up contact routes from this PC for prospects waiting on the board that don't have one yet.
//
// The digest looks up each pick's contact route from the cloud, but some sites refuse Cloudflare's
// network. This fills those in from a home connection: the same read-only lookup (src/contacts.js),
// at most two GETs per prospect, only for prospects already on the board.
//
// Usage, from workers/prospector:   node scripts/contacts-local.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const { findContact, PROSPECTOR_UA } = await import(pathToFileURL(join(DIR, "src", "contacts.js")).href);

function wrangler(args) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mobius-prospector", "--remote", "--json", ...args], {
    cwd: DIR, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf("[")));
}

const [{ results: rows }] = wrangler(["--command", `"SELECT p.id, p.name, p.website, c.final_url, o.id AS oid FROM prospects p JOIN outreach o ON o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = p.id) LEFT JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id) WHERE p.status = 'digested' AND o.contact_email IS NULL AND (o.contact_url IS NULL OR o.contact_form IS NULL)"`]);
if (!rows.length) { console.log("Every prospect on the board already has a contact route."); process.exit(0); }
console.log(`Looking up ${rows.length} contact routes from this PC...`);

const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const found = await Promise.all(rows.map(async (r) => ({ r, c: await findContact(r, { userAgent: PROSPECTOR_UA }) })));
const sql = [];
for (const { r, c } of found) {
  console.log(`  ${r.name}: ${c.email || "no email"}${c.url ? ` | contact page ${c.url}${c.form ? " (form)" : ""}` : ""}${c.error ? ` | ${c.error}` : ""}`);
  if (c.error) continue; // didn't load from here either: leave it for the next try
  sql.push(`UPDATE outreach SET contact_email = ${q(c.email)}, contact_url = ${q(c.url)}, contact_form = ${c.form ? 1 : 0}, updated_at = datetime('now') WHERE id = ${Number(r.oid)};`);
}
if (sql.length) {
  const tmp = mkdtempSync(join(tmpdir(), "contacts-"));
  const file = join(tmp, "contacts.sql");
  writeFileSync(file, sql.join("\n"));
  try { wrangler(["--file", `"${file}"`, "--yes"]); } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`Saved ${sql.length}.`);
}
