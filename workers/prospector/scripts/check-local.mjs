// Re-check prospects from this PC.
//
// Why here: many small-business sites, or their hosts' bot filters, refuse requests from Cloudflare's
// network (HTTP 403/429/520, timeouts), while a home connection gets through. This runs the Worker's
// own check code locally with `wrangler dev`, with the D1 binding pointed at the live database, twenty
// prospects per batch, until nothing is queued. Same polite one-page check, same honest User-Agent,
// same robots.txt rule as the cloud. While it runs (PC_CHECK heartbeat) the cloud's own check batches
// pause, so they don't race it. The weekday digest keeps running in the cloud.
//
// Usage, from workers/prospector:
//   node scripts/check-local.mjs             check whatever is queued (status 'new')
//   node scripts/check-local.mjs --requeue   first re-queue every waiting 'checked' prospect and every
//                                            'unreachable' one except dead domains (HTTP 530), so they
//                                            are re-checked with the current checker
// About 10-20 minutes for ~1,000 prospects.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_CONFIG = "wrangler.check-local.toml";
const PORT = 8813;
const PER_BATCH = 20; // the Worker caps CHECKS_PER_RUN at 25
const QUEUED = "status = 'new' AND sightings < 3 AND domain NOT IN (SELECT value FROM suppression)";

function d1(sql) {
  // npx needs a shell on Windows, and the shell splits arguments on spaces, so the SQL is wrapped in
  // double quotes. Keep these queries free of double quotes.
  if (sql.includes('"')) throw new Error("d1(): use single quotes inside SQL");
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mobius-prospector", "--remote", "--json", "--command", `"${sql}"`], {
    cwd: DIR, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf("[")));
}
const queued = () => d1(`SELECT COUNT(*) AS n FROM prospects WHERE ${QUEUED}`)[0].results[0].n;

if (process.argv.includes("--requeue")) {
  const [r] = d1(
    "UPDATE prospects SET status = 'new', updated_at = datetime('now') " +
    "WHERE status IN ('checked', 'unreachable') AND sightings < 3 AND domain NOT IN (SELECT value FROM suppression) " +
    "AND id NOT IN (SELECT prospect_id FROM checks WHERE status_code = 530 AND id IN (SELECT MAX(id) FROM checks GROUP BY prospect_id))",
  );
  console.log(`Re-queued ${r.meta.changes} prospects.`);
}

const total = queued();
if (!total) { console.log("Nothing queued. Run with --requeue to re-check waiting and unreachable prospects."); process.exit(0); }
console.log(`${total} prospects queued; checking ${PER_BATCH} at a time from this PC.`);

// Same config as the deployed Worker, minus its cron triggers, with the database binding set to remote
// and the batch size raised to the Worker's maximum.
const base = readFileSync(join(DIR, "wrangler.toml"), "utf8");
const config = base
  .replace(/^\[triggers\][\s\S]*?^crons = .*$/m, "")
  .replace(/^routes = .*$/m, "")
  .replace('migrations_dir = "migrations"', 'migrations_dir = "migrations"\nremote = true')
  .replace(/^CHECKS_PER_RUN = .*$/m, `CHECKS_PER_RUN = "${PER_BATCH}"\nPC_CHECK = "true"`);
if (!config.includes("remote = true")) throw new Error("Could not point the D1 binding at the live database.");
if (!config.includes(`CHECKS_PER_RUN = "${PER_BATCH}"`)) throw new Error("Could not set the batch size.");
if (!config.includes('PC_CHECK = "true"')) throw new Error("Could not mark this as a PC run.");
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
  // Use the port wrangler actually reports (it may pick another if PORT is taken).
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

  const trigger = () => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`, timeout: 3 * 60 * 1000 }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => req.destroy(new Error("check batch timed out after 3 minutes")));
    req.on("error", reject);
  });

  // Count the queue only every 10 batches: each count is a separate wrangler call (a few seconds).
  const maxBatches = Math.ceil(total / PER_BATCH) + 10;
  let left = total;
  for (let i = 1; i <= maxBatches && left > 0; i++) {
    await trigger();
    if (i % 10 === 0) {
      left = queued();
      console.log(`  ${i} batches done, ${left} left`);
    }
  }

  const [statuses, top] = d1(
    "SELECT status, COUNT(*) AS n FROM prospects GROUP BY status ORDER BY n DESC; " +
    "SELECT p.score, p.name, p.domain, c.issues_json FROM prospects p JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id) " +
    "WHERE p.status = 'checked' AND p.sightings < 3 ORDER BY p.score DESC, p.id LIMIT 12",
  );
  console.log("Prospects by status:");
  for (const r of statuses.results) console.log(`  ${r.status}: ${r.n}`);
  console.log("Top waiting prospects:");
  for (const r of top.results) console.log(`  ${r.score}  ${r.name} (${r.domain})  ${(JSON.parse(r.issues_json || "[]")).slice(0, 3).join("; ")}`);
} finally {
  stop();
}
