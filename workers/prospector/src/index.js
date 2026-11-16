// mobius-prospector: finds local Tampa Bay businesses with websites, checks their home pages
// (read-only), and emails the FOUNDER a weekly digest with drafted outreach. Nothing is ever sent
// to a prospect: the only mail this Worker sends goes through sendToFounder() below.
//
// Handlers (each does a small slice of work and exits, to stay inside the Workers Free limits):
//   scheduled "0 11 * * MON"   plan the weekly harvest: queue 6 map tiles (src/overpass.js)
//   scheduled "*/15 * * * *"   harvest ONE queued tile, or, when the queue is empty, check a few new prospects
//   scheduled "0 13 * * TUE"   build and send the weekly digest (src/digest.js)
//   email (ops@ address)       founder commands: SENT / SKIP / STOP / MORE / STATUS (src/commands.js)

import { EmailMessage } from "cloudflare:email";
import { buildMime } from "../../shared/mime.js";
import { checkSite, readCapped } from "../../shared/site-check.js";
import { planHarvest, runHarvestTile, logRun } from "./overpass.js";
import { scoreProspect } from "./score.js";
import { buildDigest, recordDigest, esc } from "./digest.js";
import { readRawMessage, extractPlainText, parseCommands } from "./commands.js";

const CRON_HARVEST = "0 11 * * MON";
const CRON_CHECK = "*/15 * * * *";
const CRON_DIGEST = "0 13 * * TUE";

const USER_AGENT = "Mozilla/5.0 (compatible; MobiusProspector/1.0; +https://mobiusintegration.com)";
const HOME_PAGE_MAX_BYTES = 150 * 1024;
const ROBOTS_MAX_BYTES = 32 * 1024;

export default {
  async scheduled(controller, env, ctx) {
    const kind = { [CRON_HARVEST]: "harvest", [CRON_CHECK]: "check", [CRON_DIGEST]: "digest" }[controller.cron];
    if (!kind) return;
    try {
      // Harvesting only happens where HARVEST_HERE is "true": scripts/harvest-local.mjs sets it when it
      // runs this code on the founder's PC. Public Overpass servers refuse Cloudflare's network, so the
      // deployed Worker never harvests; it only checks prospects and sends the digest.
      const harvestHere = env.HARVEST_HERE === "true";
      if (kind === "harvest") { if (harvestHere) await planHarvest(env); } // no Overpass query: queues the tiles
      else if (kind === "check") {
        // While tiles are queued (local harvest), this run harvests one tile and does no checks.
        if (!(harvestHere && (await runHarvestTile(env)))) await checkBatch(env);
      }
      else await sendDigest(env, num(env.DIGEST_SIZE, 5, 1, 10));
    } catch (e) {
      console.error(`prospector: ${kind} failed:`, e && e.message);
      try { await logRun(env.DB, kind, false, { error: e && e.message }); } catch {}
    }
  },

  async email(message, env, ctx) {
    const founder = String(env.FOUNDER_TO || "").toLowerCase();
    if (!founder || String(message.from || "").toLowerCase() !== founder) {
      message.setReject("Not accepted");
      return;
    }
    // Envelope senders can be forged. If the receiving MTA recorded a DMARC failure, don't act.
    if (/\bdmarc=fail\b/i.test(message.headers.get("authentication-results") || "")) {
      message.setReject("Not accepted");
      return;
    }
    try {
      const text = extractPlainText(await readRawMessage(message.raw));
      const { commands, unknown } = parseCommands(text);
      const report = await runCommands(env, commands, unknown);
      const subject = `Prospector: ${commands.length} command${commands.length === 1 ? "" : "s"} handled`;
      await sendToFounder(env, subject, report, `<pre style="font-family:inherit;font-size:14px;white-space:pre-wrap">${esc(report)}</pre>`);
    } catch (e) {
      console.error("prospector: email handler failed:", e && e.message);
      try { await logRun(env.DB, "email", false, { error: e && e.message }); } catch {}
    }
  },
};

const num = (v, dflt, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || dflt));

// ---------------------------------------------------------------------------
// The only way this Worker sends mail. The recipient is never a parameter: it is env.FOUNDER_TO.

export async function sendToFounder(env, subject, text, html) {
  const to = env.FOUNDER_TO;
  if (typeof to !== "string" || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(to) || to.length > 254) {
    throw new Error("FOUNDER_TO secret is not set to a single valid address; refusing to send");
  }
  if (!env.FROM_ADDRESS) throw new Error("FROM_ADDRESS is not set");
  const raw = buildMime({
    from: `"Mobius prospects" <${env.FROM_ADDRESS}>`,
    to,
    replyTo: env.OPS_ADDRESS,
    subject,
    text,
    html,
    domain: env.FROM_ADDRESS.split("@")[1],
  });
  const toHeader = /^To: (.*)$/m.exec(raw);
  if (!toHeader || toHeader[1].trim().toLowerCase() !== to.toLowerCase()) throw new Error("recipient mismatch; refusing to send");
  await env.MAILER.send(new EmailMessage(env.FROM_ADDRESS, to, raw));
}

// ---------------------------------------------------------------------------
// Check batch

// True when the "User-agent: *" group (or ours) contains exactly "Disallow: /".
export function robotsDisallowsAll(text) {
  let agents = [];
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ""));
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === "user-agent") {
      if (!inAgents) { agents = []; inAgents = true; }
      agents.push(m[2].toLowerCase());
    } else {
      inAgents = false;
      if (field === "disallow" && m[2] === "/" && agents.some((a) => a === "*" || a.includes("mobiusprospector"))) return true;
    }
  }
  return false;
}

async function robotsBlocked(domain) {
  try {
    const res = await fetch(`https://${domain}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status !== 200) {
      try { await res.body.cancel(); } catch {}
      return false;
    }
    return robotsDisallowsAll(await readCapped(res, ROBOTS_MAX_BYTES));
  } catch {
    return false; // no robots.txt we can read: nothing to respect
  }
}

async function checkOne(p) {
  if (await robotsBlocked(p.domain)) return { p, robots: true };
  const check = await checkSite(p.website, { maxBytes: HOME_PAGE_MAX_BYTES, userAgent: USER_AGENT, timeoutMs: 8000, httpFallback: true });
  return { p, check };
}

export async function checkBatch(env) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT id, domain, website, category, phone FROM prospects
      WHERE status = 'new' AND sightings < 3 AND domain NOT IN (SELECT value FROM suppression)
      ORDER BY first_seen, id LIMIT ?`
  ).bind(num(env.CHECKS_PER_RUN, 5, 1, 10)).all();
  if (!results || !results.length) return; // idle runs cost one query

  const outcomes = await Promise.all(results.map((p) => checkOne(p).catch((e) => ({ p, check: { ok: false, error: `Check crashed: ${e && e.message}` } }))));

  const stmts = [];
  const summary = { checked: 0, unreachable: 0, robots_skip: 0, skipped: 0 };
  for (const o of outcomes) {
    const { p } = o;
    if (o.robots) {
      summary.robots_skip++;
      stmts.push(db.prepare("UPDATE prospects SET status='robots_skip', updated_at=datetime('now') WHERE id=?").bind(p.id));
      continue;
    }
    const c = o.check;
    const m = c.metrics || {};
    const score = scoreProspect(p, c);
    const status = c.ok ? "checked" : c.skipped ? "skipped" : "unreachable";
    summary[status]++;
    stmts.push(
      db.prepare(
        `INSERT INTO checks (prospect_id, ok, status_code, ms, final_url, https, viewport, imgs_total, imgs_no_alt, fields_unlabeled, booking, issues_json, good_json, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        p.id, c.ok ? 1 : 0, c.status ?? null, c.ms ?? null, c.url ? String(c.url).slice(0, 500) : null,
        c.ok ? (m.https ? 1 : 0) : null, c.ok ? (m.viewport ? 1 : 0) : null, c.ok ? m.imgsTotal : null, c.ok ? m.imgsNoAlt : null, c.ok ? m.fieldsUnlabeled : null,
        c.ok ? (c.booking && c.booking.length ? c.booking.join(", ") : m.noBooking ? "" : "mentioned") : null,
        c.ok ? JSON.stringify(c.issues) : null, c.ok ? JSON.stringify(c.good) : null, c.ok ? null : String(c.error || "").slice(0, 300)
      ),
      db.prepare("UPDATE prospects SET status=?, score=?, updated_at=datetime('now') WHERE id=?").bind(status, score.total, p.id)
    );
  }
  stmts.push(db.prepare("INSERT INTO runs (kind, ok, detail) VALUES ('check', 1, ?)").bind(JSON.stringify(summary)));
  await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// Digest

export async function sendDigest(env, limit) {
  if (!env.FOUNDER_TO) throw new Error("FOUNDER_TO secret is not set");
  const digest = await buildDigest(env, limit);
  if (!digest) return { sent: 0 };
  await sendToFounder(env, digest.subject, digest.text, digest.html);
  await recordDigest(env.DB, digest.items);
  return { sent: digest.items.length, subject: digest.subject };
}

// ---------------------------------------------------------------------------
// Founder commands

async function runCommands(env, commands, unknown) {
  const db = env.DB;
  const lines = [];
  const stmts = [];
  const plan = []; // one entry per command that touches the database, with the index of its first statement

  for (const c of commands) {
    const v = c.target && c.target.value;
    if (c.cmd === "SENT") {
      plan.push({ c, at: stmts.length, n: 2 });
      stmts.push(
        db.prepare("UPDATE outreach SET founder_status='sent', updated_at=datetime('now') WHERE prospect_id=(SELECT id FROM prospects WHERE domain=?)").bind(v),
        db.prepare("UPDATE prospects SET status='sent', updated_at=datetime('now') WHERE domain=? AND status != 'suppressed'").bind(v)
      );
    } else if (c.cmd === "SKIP") {
      plan.push({ c, at: stmts.length, n: 2 });
      stmts.push(
        db.prepare("UPDATE outreach SET founder_status='skipped', updated_at=datetime('now') WHERE prospect_id=(SELECT id FROM prospects WHERE domain=?)").bind(v),
        db.prepare("UPDATE prospects SET status='skipped', updated_at=datetime('now') WHERE domain=? AND status != 'suppressed'").bind(v)
      );
    } else if (c.cmd === "STOP") {
      plan.push({ c, at: stmts.length, n: 2 });
      const domain = c.target.kind === "email" ? v.split("@")[1] : v;
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO suppression (value, reason) VALUES (?, 'founder STOP command')").bind(v),
        // A STOP for an address also parks any prospect on that address's domain.
        db.prepare("UPDATE prospects SET status='suppressed', updated_at=datetime('now') WHERE domain=?").bind(domain)
      );
    }
  }
  const results = stmts.length ? await db.batch(stmts) : [];
  const changes = (i) => (results[i] && results[i].meta && results[i].meta.changes) || 0;

  for (const c of commands) {
    const p = plan.find((x) => x.c === c);
    if (c.cmd === "SENT") lines.push(changes(p.at + 1) ? `SENT ${c.target.value}: marked as sent.` : `SENT ${c.target.value}: no matching prospect (or it is suppressed). Nothing changed.`);
    else if (c.cmd === "SKIP") lines.push(changes(p.at + 1) ? `SKIP ${c.target.value}: marked as skipped.` : `SKIP ${c.target.value}: no matching prospect (or it is suppressed). Nothing changed.`);
    else if (c.cmd === "STOP") {
      lines.push(`STOP ${c.target.value}: ${changes(p.at) ? "added to the suppression list" : "already on the suppression list"}` +
        (changes(p.at + 1) ? "; matching prospect marked suppressed." : "."));
    } else if (c.cmd === "STATUS") {
      const [counts, runs] = await db.batch([
        db.prepare("SELECT status, COUNT(*) AS n FROM prospects GROUP BY status ORDER BY n DESC"),
        db.prepare("SELECT kind, started_at, ok, detail FROM runs ORDER BY id DESC LIMIT 5"),
      ]);
      lines.push("STATUS", "Prospects by status:");
      if (!counts.results.length) lines.push("  (none yet)");
      for (const r of counts.results) lines.push(`  ${r.status}: ${r.n}`);
      lines.push("Last runs:");
      if (!runs.results.length) lines.push("  (none yet)");
      for (const r of runs.results) lines.push(`  ${r.started_at} ${r.kind} ${r.ok ? "ok" : "FAILED"} ${String(r.detail || "").slice(0, 160)}`);
    } else if (c.cmd === "MORE") {
      try {
        const r = await sendDigest(env, num(env.DIGEST_SIZE, 5, 1, 10));
        lines.push(r.sent ? `MORE: sent a digest with ${r.sent} prospect${r.sent === 1 ? "" : "s"}.` : "MORE: no checked prospects are waiting.");
      } catch (e) {
        lines.push(`MORE: failed (${e && e.message}).`);
      }
    }
  }

  if (!commands.length) lines.push("I didn't find any commands in your message.");
  if (unknown.length) {
    lines.push("", "Lines I didn't understand (ignored):");
    for (const u of unknown) lines.push(`  ${u}`);
  }
  lines.push("", "Commands: SENT <domain>, SKIP <domain>, STOP <domain-or-email>, MORE, STATUS. Put them before any quoted text.");
  return lines.join("\n");
}
