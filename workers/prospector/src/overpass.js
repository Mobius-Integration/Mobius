// Weekly harvest: Overpass queries (one per map tile, one tile per run) for local businesses that list a website in OpenStreetMap.
//
// We store only what OSM publishes about the business (name, website, phone, city, category).
// No email addresses are collected, guessed or stored. Business data (c) OpenStreetMap contributors.
//
// CPU note: the result is requested as CSV so parsing is a cheap split, and rows are written with
// multi-row INSERTs inside a few db.batch() calls (a batch counts as one D1 query).

// The bare overpass-api.de host answers Cloudflare's network with HTTP 521 (checked 2026-11-15), while its
// official aliases lz4. and z. answer normally, so the Worker uses those. Worst case per run is
// 3 x 150 s plus 2 x 30 s waits, well inside the 15-minute limit for cron handlers.
const ENDPOINTS = [
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const USER_AGENT = "MobiusProspector/1.0 (+https://mobiusintegration.com)";
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const ROWS_PER_STATEMENT = 12; // 8 bound values per row; D1 allows 100 bound values per statement
const STATEMENTS_PER_BATCH = 50;
const MAX_BATCHES = 45;

// Columns of the CSV, in query order.
const COLS = ["type", "id", "name", "website", "contact:website", "amenity", "shop", "craft", "office", "leisure", "addr:city", "phone", "contact:phone"];

export function buildQuery(bbox) {
  if (!/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(bbox)) throw new Error("BBOX must be four comma-separated numbers");
  const cols = COLS.map((c, i) => (i < 2 ? `::${c}` : /[^a-z]/.test(c) ? `"${c}"` : c)).join(",");
  return `[out:csv(${cols};true;"\\t")][timeout:120][bbox:${bbox}];
(
  nwr["amenity"~"^(restaurant|cafe|bar|pub|fast_food)$"];
  nwr["amenity"~"^(dentist|doctors|clinic)$"];
  nwr["shop"~"^(hairdresser|beauty|massage|tattoo)$"];
  nwr["leisure"~"^(fitness_centre|sports_centre)$"];
  nwr["shop"]["shop"!~"^(hairdresser|beauty|massage|tattoo|vacant|yes|no)$"];
  nwr["craft"];
  nwr["office"~"^(construction_company|architect|insurance|financial_advisor|lawyer|accountant|estate_agent|tax_advisor)$"];
)->.all;
nwr.all["name"][~"^(contact:)?website$"~"."][!"brand"][!"brand:wikidata"];
out tags;`;
}

// Social networks, listing sites and free site builders: not a business's own website.
const SKIP_DOMAINS = [
  "facebook.com", "instagram.com", "yelp.com", "linktr.ee", "tiktok.com", "x.com", "twitter.com",
  "google.com", "sites.google.com", "business.site", "square.site",
];
// National and regional chains we don't pitch.
const CHAIN_NAME = /^(publix|walgreens|cvs|walmart|starbucks|mcdonald|subway|dunkin|7[- ]?eleven|wawa|adventhealth|baycare|hca\b|tampa general hospital)/i;
const TARGET_STORE = /^target(\s*[#(\d-].*)?$/i;

const SALON_SHOPS = new Set(["hairdresser", "beauty", "massage", "tattoo"]);
const NOT_RETAIL = new Set(["hairdresser", "beauty", "massage", "tattoo", "vacant", "yes", "no", ""]);

export function categoryFor(amenity, shop, craft, office, leisure) {
  if (/^(restaurant|cafe|bar|pub|fast_food)$/.test(amenity)) return "restaurants";
  if (/^(dentist|doctors|clinic)$/.test(amenity)) return "dental-medical";
  if (SALON_SHOPS.has(shop)) return "medspa-salon";
  if (leisure === "fitness_centre" || leisure === "sports_centre") return "fitness";
  if (/^(lawyer|accountant|tax_advisor|insurance|financial_advisor)$/.test(office)) return "professional";
  if (office === "estate_agent") return "real-estate";
  if (craft || office === "construction_company" || office === "architect") return "home-services";
  if (shop && !NOT_RETAIL.has(shop)) return "retail";
  return null;
}

// Returns { domain, website } or null. One regex and no URL parser: this runs once per row.
const SITE_RE = /^(?:(https?):\/\/)?(?:www\.)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d{1,5})?(?:[/?#]|$)/i;
export function normalizeSite(raw) {
  if (!raw) return null;
  const semi = raw.indexOf(";");
  const s = (semi < 0 ? raw : raw.slice(0, semi)).trim();
  if (!s || s.length > 300 || s.indexOf(" ") >= 0) return null;
  const m = SITE_RE.exec(s);
  if (!m) return null;
  const domain = m[2].toLowerCase();
  if (domain.length > 253 || domain.indexOf("..") >= 0 || domain.endsWith("-") || domain.indexOf(".-") >= 0 || domain.indexOf("-.") >= 0) return null;
  // Stored URL is https (upgraded from http; the check discovers if HTTPS really fails).
  const rest = m[1] ? s.slice(m[1].length + 3) : s;
  const hash = rest.indexOf("#");
  return { domain, website: "https://" + (hash < 0 ? rest : rest.slice(0, hash)) };
}

function skippedDomain(domain) {
  for (const d of SKIP_DOMAINS) if (domain === d || domain.endsWith("." + d)) return true;
  return false;
}

const clip = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

// CSV text -> kept prospects. Pure function so it can be benchmarked and tested without a network.
export function parseHarvest(csv) {
  const lines = csv.split("\n");
  const stats = { parsed: 0, noSite: 0, badSite: 0, socialOrAggregator: 0, noCategory: 0, nationalName: 0, chainDomain: 0, chainName: 0, duplicate: 0, kept: 0 };
  if (!lines[0] || !lines[0].startsWith("@type")) throw new Error("Overpass returned something that isn't CSV: " + clip(csv, 160));

  const candidates = [];
  const domainCount = new Map();
  const nameCount = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split("\t");
    if (f.length < 13) continue;
    stats.parsed++;
    const name = clip(f[2], 120);
    const site = f[3] || f[4];
    if (!name || !site) { stats.noSite++; continue; }
    const norm = normalizeSite(site);
    if (!norm) { stats.badSite++; continue; }
    if (skippedDomain(norm.domain)) { stats.socialOrAggregator++; continue; }
    const category = categoryFor(f[5], f[6], f[7], f[8], f[9]);
    if (!category) { stats.noCategory++; continue; }
    if (CHAIN_NAME.test(name) || TARGET_STORE.test(name)) { stats.nationalName++; continue; }
    const nameKey = name.toLowerCase();
    domainCount.set(norm.domain, (domainCount.get(norm.domain) || 0) + 1);
    nameCount.set(nameKey, (nameCount.get(nameKey) || 0) + 1);
    candidates.push({
      osm_key: `${f[0].toLowerCase()}/${f[1]}`.slice(0, 40),
      domain: norm.domain, website: norm.website, name, nameKey, category,
      city: clip(f[10], 60) || null,
      phone: clip(f[11] || f[12], 40) || null,
    });
  }

  const seen = new Set();
  const kept = [];
  for (const c of candidates) {
    if (seen.has(c.domain)) { stats.duplicate++; continue; }
    seen.add(c.domain);
    c.sightings = domainCount.get(c.domain); // how many OSM objects in this tile share the domain
    // Chains are stored (not dropped) with sightings >= 3, so the check batch and the digest
    // (both filter sightings < 3) keep excluding them even when another tile sees them only once.
    if (c.sightings >= 3) stats.chainDomain++;                                                     // a chain sharing one site
    if (nameCount.get(c.nameKey) >= 4) { stats.chainName++; c.sightings = Math.max(c.sightings, 3); } // same name 4+ times
    kept.push(c);
  }
  stats.kept = kept.length;
  return { kept, stats };
}

export function buildUpsertStatements(db, rows) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    const sql =
      "INSERT INTO prospects (osm_key, domain, website, name, category, city, phone, sightings) VALUES " +
      chunk.map(() => "(?,?,?,?,?,?,?,?)").join(",") +
      // status and score are never touched on update; sightings adds up across the week's tiles.
      " ON CONFLICT(domain) DO UPDATE SET name=excluded.name, phone=excluded.phone, city=excluded.city, last_seen=datetime('now'), sightings=prospects.sightings+excluded.sightings";
    const binds = [];
    for (const r of chunk) binds.push(r.osm_key, r.domain, r.website, r.name, r.category, r.city, r.phone, r.sightings || 1);
    stmts.push(db.prepare(sql).bind(...binds));
  }
  return stmts;
}

async function fetchOverpass(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(150000),
  });
  if (RETRY_STATUS.has(res.status)) {
    try { await res.body.cancel(); } catch {}
    const e = new Error(`HTTP ${res.status}`);
    e.retry = true;
    throw e;
  }
  if (!res.ok) {
    try { await res.body.cancel(); } catch {}
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

export async function logRun(db, kind, ok, detail) {
  await db.prepare("INSERT INTO runs (kind, ok, detail) VALUES (?,?,?)").bind(kind, ok ? 1 : 0, clip(typeof detail === "string" ? detail : JSON.stringify(detail), 900)).run();
}

// ---------------------------------------------------------------------------
// Tiles: BBOX is split into a grid so each run does a small slice of work (CPU) and each Overpass
// query stays small. The Monday cron only plans; the */15 cron works through the queue.

const QUEUE_KEY = "harvest_queue";
const MAX_ATTEMPTS = 3;
export const GRID_COLS = 2;
export const GRID_ROWS = 3;

// "south,west,north,east" -> cols x rows tiles in the same format, sharing exact edge values so
// together they cover the box with no gaps. Row-major, south to north.
export function splitBbox(bbox, cols = GRID_COLS, rows = GRID_ROWS) {
  const [s, w, n, e] = bbox.split(",").map(Number);
  if ([s, w, n, e].some((x) => !Number.isFinite(x)) || s >= n || w >= e) throw new Error("BBOX must be south,west,north,east");
  const edge = (a, b, i, k) => (i === 0 ? a : i === k ? b : Math.round((a + ((b - a) * i) / k) * 1e5) / 1e5);
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push([edge(s, n, r, rows), edge(w, e, c, cols), edge(s, n, r + 1, rows), edge(w, e, c + 1, cols)].join(","));
    }
  }
  return tiles;
}

async function loadQueue(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(QUEUE_KEY).first();
  if (!row) return [];
  try { const q = JSON.parse(row.value); return Array.isArray(q) ? q : []; } catch { return []; }
}

async function saveQueue(db, queue) {
  await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(QUEUE_KEY, JSON.stringify(queue)).run();
}

// Monday cron: no Overpass query. Reset the week's sightings and queue the tiles.
export async function planHarvest(env) {
  const db = env.DB;
  const left = (await loadQueue(db)).length;
  const tiles = splitBbox(env.BBOX || "27.60,-82.85,28.10,-82.25");
  await db.batch([
    db.prepare("UPDATE prospects SET sightings = 0"),
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(QUEUE_KEY, JSON.stringify(tiles.map((bbox) => ({ bbox, attempts: 0 })))),
  ]);
  await logRun(db, "harvest_plan", true, { tiles: tiles.length, leftover_from_last_week: left });
  return { tiles: tiles.length, left };
}

// */15 cron: if tiles are queued, harvest exactly one and return true (the caller then skips the
// check batch this run). Returns false when the queue is empty.
export async function runHarvestTile(env, opts = {}) {
  const db = env.DB;
  const queue = await loadQueue(db);
  while (queue.length && (queue[0].attempts || 0) >= MAX_ATTEMPTS) {
    const dropped = queue.shift();
    await logRun(db, "harvest_tile", false, { dropped: dropped.bbox, reason: `gave up after ${dropped.attempts} attempts` });
    await saveQueue(db, queue);
  }
  if (!queue.length) return false;

  // Count the attempt and re-queue at the end BEFORE doing the work, so a run that is killed
  // part-way (CPU limit, crash) can't make the same tile loop forever.
  const tile = queue.shift();
  tile.attempts = (tile.attempts || 0) + 1;
  await saveQueue(db, [...queue, tile]);

  const result = await harvestTile(env, tile.bbox, opts);
  if (result.ok) {
    await saveQueue(db, queue); // done: leave it out
  } else if (tile.attempts >= MAX_ATTEMPTS) {
    await saveQueue(db, queue);
    await logRun(db, "harvest_tile", false, { dropped: tile.bbox, reason: `gave up after ${tile.attempts} attempts`, errors: result.errors });
  } // else: stays at the end of the queue with its attempt counter
  return true;
}

// One Overpass query for one tile, then upsert. On 429/5xx or a network error, wait 30 s and try the
// next endpoint (each endpoint once).
export async function harvestTile(env, bbox, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const db = env.DB;
  const query = buildQuery(bbox);

  let csv;
  const errors = [];
  for (let i = 0; i < ENDPOINTS.length && csv === undefined; i++) {
    try {
      csv = await fetchOverpass(ENDPOINTS[i], query);
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      errors.push(`${new URL(ENDPOINTS[i]).host}: ${timedOut ? "timeout" : e.message}`);
      if (i + 1 < ENDPOINTS.length) await sleep(30000);
    }
  }
  if (csv === undefined) {
    await logRun(db, "harvest_tile", false, { bbox, error: "all Overpass endpoints failed", errors });
    return { ok: false, errors };
  }

  let parsed;
  try {
    parsed = parseHarvest(csv);
  } catch (e) {
    await logRun(db, "harvest_tile", false, { bbox, error: e.message });
    return { ok: false, errors: [e.message] };
  }
  const { kept, stats } = parsed;

  const before = (await db.prepare("SELECT COUNT(*) AS n FROM prospects").first()).n;
  const stmts = buildUpsertStatements(db, kept);
  let batches = 0;
  let truncated = false;
  for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
    if (batches >= MAX_BATCHES) { truncated = true; break; }
    await db.batch(stmts.slice(i, i + STATEMENTS_PER_BATCH));
    batches++;
  }
  const after = (await db.prepare("SELECT COUNT(*) AS n FROM prospects").first()).n;
  const byCategory = {};
  for (const r of kept) byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  const detail = { bbox, ...stats, inserted: after - before, batches, truncated, byCategory };
  await logRun(db, "harvest_tile", true, detail);
  return { ok: true, ...detail };
}
