// Refresh the prospect list from this PC.
//
// Why here and not in the cloud: the public Overpass servers refuse requests from Cloudflare's network
// (HTTP 521, seen 2026-11-15), but answer a home connection normally. So the harvest runs the Worker's
// own code locally with `wrangler dev`, with the D1 binding pointed at the live database. Site checks
// and the Tuesday digest keep running in the cloud.
//
// Usage, from workers/prospector:   node scripts/harvest-local.mjs
// One Overpass query per tile (GRID in wrangler.toml, 20 tiles since 2026-11-20), one at a time with a
// pause between them: about 15-25 minutes. Monthly is plenty.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_CONFIG = "wrangler.harvest-local.toml";
const PORT = 8812;
const ATTEMPTS_PER_TILE = 3; // the same cap the Worker uses

function d1(sql) {
  // npx needs a shell on Windows, and the shell splits arguments on spaces, so the SQL is wrapped in
  // double quotes. Keep these queries free of double quotes.
  if (sql.includes('"')) throw new Error("d1(): use single quotes inside SQL");
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mobius-prospector", "--remote", "--json", "--command", `"${sql}"`], {
    cwd: DIR, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.slice(out.indexOf("[")));
}

const tilesLeft = () => {
  const rows = d1("SELECT value FROM meta WHERE key = 'harvest_queue'")[0].results;
  return rows.length ? JSON.parse(rows[0].value).length : 0;
};

// Same config as the deployed Worker, minus its cron triggers, with the database binding set to remote
// and HARVEST_HERE switched on (the deployed Worker never harvests).
const base = readFileSync(join(DIR, "wrangler.toml"), "utf8");
const config = base
  .replace(/^\[triggers\][\s\S]*?^crons = .*$/m, "")
  .replace(/^routes = .*$/m, "")
  .replace('migrations_dir = "migrations"', 'migrations_dir = "migrations"\nremote = true')
  .replace(/^\[vars\]$/m, '[vars]\nHARVEST_HERE = "true"');
if (!config.includes("remote = true")) throw new Error("Could not point the D1 binding at the live database.");
if (!config.includes('HARVEST_HERE = "true"')) throw new Error("Could not switch harvesting on for the local run.");
writeFileSync(join(DIR, TEMP_CONFIG), config);

const dev = spawn("npx", ["wrangler", "dev", "--config", TEMP_CONFIG, "--test-scheduled", "--port", String(PORT)], {
  cwd: DIR, shell: true, stdio: ["ignore", "pipe", "pipe"],
});

function stop() {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
    else dev.kill("SIGTERM");
  } catch { /* already stopped */ }
  rmSync(join(DIR, TEMP_CONFIG), { force: true });
}

try {
  // Use the port wrangler actually reports: if PORT is taken it may pick another, and an old server
  // still holding PORT would otherwise receive our triggers.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev did not start within 90 s")), 90000);
    const onData = (chunk) => {
      const m = String(chunk).match(/Ready on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    dev.stdout.on("data", onData);
    dev.stderr.on("data", onData);
    dev.on("exit", (code) => reject(new Error(`wrangler dev exited early (code ${code})`)));
  });

  // node:http rather than fetch: a slow Overpass tile can take longer than fetch's 5-minute header timeout.
  const trigger = (cron) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/__scheduled?cron=${encodeURIComponent(cron)}`, timeout: 15 * 60 * 1000 }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("trigger timed out after 15 minutes")));
    req.on("error", reject);
  });

  await trigger("0 11 * * MON"); // plan: reset sightings, queue the tiles
  const queuedTiles = tilesLeft();
  console.log(`Queued ${queuedTiles} tiles.`);
  for (let i = 0; i < queuedTiles * ATTEMPTS_PER_TILE; i++) {
    const left = tilesLeft();
    if (left === 0) break;
    console.log(`Harvesting a tile (${left} left)...`);
    await trigger("*/15 * * * *");
    await new Promise((r) => setTimeout(r, 8000)); // be polite to the shared Overpass servers
  }

  const [runs, totals] = d1(
    `SELECT ok, substr(detail, 1, 120) AS detail FROM runs WHERE kind = 'harvest_tile' ORDER BY id DESC LIMIT ${queuedTiles}; ` +
    "SELECT COUNT(*) AS prospects, SUM(sightings >= 3) AS chains FROM prospects",
  );
  for (const r of runs.results) console.log(r.ok ? "ok  " : "FAIL", r.detail);
  console.log(`Prospects in the database: ${totals.results[0].prospects} (chains filtered: ${totals.results[0].chains || 0}).`);
} finally {
  stop();
}
