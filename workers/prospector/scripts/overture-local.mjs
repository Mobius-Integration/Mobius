// Import law firms and referral partners from Overture Maps places (run from this PC).
//
// Overture Maps publishes open places data (CDLA Permissive 2.0) as Parquet files on a public bucket.
// DuckDB reads only the parts that cover our box, about 25 MB for Tampa Bay, in roughly 10 seconds.
// Overture lists about 3,000 law firms in the box, against about 60 in OpenStreetMap.
//
// What it imports (see src/partners.js):
//   - law firms whose clients are mostly people (personal injury, family, criminal, estate...): track 'client'
//   - business, real estate, tax and IP lawyers, accountants, bookkeepers, payroll, insurance agencies,
//     print and sign shops: track 'partner'
// It skips chains (a brand, a chain name, or a website shared by 3+ places), social and listing sites,
// closed places and low-confidence places. Overture's email addresses are never read: contact routes still
// come only from each business's own website, at digest time.
//
// New rows land as status 'new', so the */15 cloud checks or `node scripts/check-local.mjs` check them.
// A domain already on the list keeps its row; if it was an OpenStreetMap row with no kind yet and hasn't
// been emailed, it gains the Overture kind and track.
//
// Usage, from workers/prospector:
//   (once) cd scripts/overture && npm install
//   node scripts/overture-local.mjs                     dry run: counts and samples, writes nothing
//   node scripts/overture-local.mjs --apply             insert into the live database
//   node scripts/overture-local.mjs --release 2026-11-18.0   a specific release (default: the newest)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSite, skippedDomain, CHAIN_NAME, TARGET_STORE } from "../src/overpass.js";
import { LAW_CLIENT_KINDS, PARTNER_KINDS, lawishName } from "../src/partners.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(DIR, "scripts", "overture", "package.json"));
let duck;
try { duck = require("@duckdb/node-api"); } catch {
  console.error("DuckDB isn't installed. Run: cd scripts/overture && npm install");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
const MIN_CONFIDENCE = 0.5;
const ROWS_PER_STATEMENT = 50;
// Captive agents of national insurers and franchise tax offices: the brand decides vendors, not the local office.
const CAPTIVE = /\b(state ?farm|allstate|farmers insurance|nationwide|geico|progressive|liberty mutual|american family|farm bureau|aflac|primerica|new york life|northwestern mutual|mass ?mutual|edward jones|h ?& ?r block|jackson hewitt|liberty tax)\b/i;

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const sqlStr = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const clip = (s, n) => (s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) || null);

async function latestRelease() {
  const res = await fetch("https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/");
  const xml = await res.text();
  const releases = [...xml.matchAll(/<Prefix>release\/(\d{4}-\d{2}-\d{2}\.\d+)\/<\/Prefix>/g)].map((m) => m[1]).sort();
  if (!releases.length) throw new Error("Could not list Overture releases.");
  return releases[releases.length - 1];
}

function bboxFromConfig() {
  const m = /^BBOX = "([^"]+)"/m.exec(readFileSync(join(DIR, "wrangler.toml"), "utf8"));
  if (!m) throw new Error("BBOX not found in wrangler.toml");
  const [s, w, n, e] = m[1].split(",").map(Number);
  if ([s, w, n, e].some((x) => !Number.isFinite(x))) throw new Error("BBOX must be four numbers");
  return { s, w, n, e };
}

function d1(args) {
  return execFileSync("npx", ["wrangler", "d1", "execute", "mobius-prospector", "--remote", ...args], {
    cwd: DIR, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
}

const release = arg("--release") || (await latestRelease());
if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)) throw new Error("--release looks like 2026-11-18.0");
const box = bboxFromConfig();
const kinds = [...LAW_CLIENT_KINDS, "legal_service", ...Object.keys(PARTNER_KINDS)];
console.log(`Overture release ${release}, box ${box.s},${box.w},${box.n},${box.e}${APPLY ? "" : " (dry run)"}`);

const db = await duck.DuckDBInstance.create(":memory:");
const c = await db.connect();
await c.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
const src = `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet`;
const inBox = `bbox.xmin BETWEEN ${box.w} AND ${box.e} AND bbox.ymin BETWEEN ${box.s} AND ${box.n}`;
await c.run(`CREATE TABLE box AS
  SELECT id, names.primary AS name, taxonomy.primary AS kind, websites[1] AS website, phones[1] AS phone,
         addresses[1].locality AS city, confidence, operating_status, brand.names.primary AS brand
    FROM read_parquet('${src}', hive_partitioning=1)
   WHERE ${inBox} AND len(websites) > 0`);
const rows = (await c.runAndReadAll(`SELECT * FROM box`)).getRowObjectsJson();
console.log(`${rows.length} places with a website in the box.`);

// Chain filter: how many places in the whole box share each website domain.
const domainCount = new Map();
for (const r of rows) {
  const norm = normalizeSite(r.website);
  if (norm) domainCount.set(norm.domain, (domainCount.get(norm.domain) || 0) + 1);
}

const wanted = new Set(kinds);
const stats = { inKinds: 0, closed: 0, lowConfidence: 0, brand: 0, notLaw: 0, badSite: 0, social: 0, chainName: 0, chainDomain: 0, duplicate: 0, kept: 0 };
const keep = new Map();
for (const r of rows.filter((x) => wanted.has(x.kind)).sort((a, b) => Number(b.confidence) - Number(a.confidence))) {
  stats.inKinds++;
  if (r.operating_status && r.operating_status !== "open") { stats.closed++; continue; }
  if (Number(r.confidence) < MIN_CONFIDENCE) { stats.lowConfidence++; continue; }
  if (r.brand) { stats.brand++; continue; }
  const name = clip(r.name, 120);
  if (!name) { stats.badSite++; continue; }
  if (r.kind === "legal_service" && !lawishName(name)) { stats.notLaw++; continue; }
  const norm = normalizeSite(r.website);
  if (!norm) { stats.badSite++; continue; }
  if (skippedDomain(norm.domain)) { stats.social++; continue; }
  if (CHAIN_NAME.test(name) || TARGET_STORE.test(name) || CAPTIVE.test(name)) { stats.chainName++; continue; }
  if ((domainCount.get(norm.domain) || 0) >= 3) { stats.chainDomain++; continue; }
  if (keep.has(norm.domain)) { stats.duplicate++; continue; }
  const track = PARTNER_KINDS[r.kind] ? "partner" : "client";
  keep.set(norm.domain, {
    key: `ov/${r.id}`, domain: norm.domain, website: norm.website, name, kind: r.kind, track,
    city: clip(r.city, 60), phone: clip(r.phone, 40),
  });
}
stats.kept = keep.size;
console.log("Filter:", JSON.stringify(stats));

const byKind = {};
for (const r of keep.values()) byKind[`${r.track}:${r.kind}`] = (byKind[`${r.track}:${r.kind}`] || 0) + 1;
console.log("Kept by track and kind:");
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

// Which domains are already on the list (for the report; the INSERT handles conflicts itself).
const existing = new Set();
const out = d1(["--json", "--command", `"SELECT domain FROM prospects"`]);
for (const r of JSON.parse(out.slice(out.indexOf("[")))[0].results) existing.add(r.domain);
const fresh = [...keep.values()].filter((r) => !existing.has(r.domain));
console.log(`${fresh.length} new to the list, ${keep.size - fresh.length} already on it.`);
console.log("Sample:", fresh.slice(0, 8).map((r) => `${r.name} (${r.kind}, ${r.domain})`).join("; "));

if (!APPLY) { console.log("Dry run: nothing written. Add --apply to import."); process.exit(0); }

const all = [...keep.values()];
const stmts = [];
for (let i = 0; i < all.length; i += ROWS_PER_STATEMENT) {
  const chunk = all.slice(i, i + ROWS_PER_STATEMENT);
  stmts.push(
    "INSERT INTO prospects (osm_key, domain, website, name, category, city, phone, sightings, source, kind, track) VALUES " +
    chunk.map((r) => `(${[r.key, r.domain, r.website, r.name, "professional", r.city, r.phone].map(sqlStr).join(",")},1,'overture',${sqlStr(r.kind)},${sqlStr(r.track)})`).join(",") +
    // An OpenStreetMap row for the same site gains the kind, and the track too while it hasn't been emailed.
    " ON CONFLICT(domain) DO UPDATE SET kind = COALESCE(prospects.kind, excluded.kind)," +
    " track = CASE WHEN prospects.kind IS NULL AND prospects.status IN ('new','checked','unreachable','robots_skip') THEN excluded.track ELSE prospects.track END;"
  );
}
stmts.push(`INSERT INTO runs (kind, ok, detail) VALUES ('overture_import', 1, ${sqlStr(JSON.stringify({ release, ...stats, new: fresh.length }))});`);
const tmp = mkdtempSync(join(tmpdir(), "overture-"));
const file = join(tmp, "import.sql");
writeFileSync(file, stmts.join("\n") + "\n", "utf8");
try {
  const res = d1(["--file", `"${file}"`, "-y"]);
  console.log((res.match(/"rows_written": \d+/g) || [res.slice(-300)]).slice(-3).join("\n"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const after = d1(["--json", "--command", `"SELECT track, status, COUNT(*) AS n FROM prospects WHERE source = 'overture' GROUP BY track, status"`]);
console.log("Overture rows now:", JSON.stringify(JSON.parse(after.slice(after.indexOf("[")))[0].results));
console.log("Next: node scripts/check-local.mjs (checks everything with status 'new').");
