// mobius-prospector: finds local Tampa Bay businesses with websites, checks their home pages
// (read-only), drafts outreach, and runs the founder's prospect board. This Worker's own mail only ever
// goes to the founder (sendToFounder() in src/mail.js). Emails to prospects (first emails and follow-ups,
// since 2026-11-23) are sent by the agent, a script inside the founder's own mailbox, never by this
// Worker: see src/agent.js and src/outbox.js.
//
// Handlers:
//   scheduled "0 11 * * MON"      plan a harvest (local runs on the founder's PC only, see src/overpass.js)
//   scheduled "*/15 * * * *"      harvest ONE queued tile (PC only), or check a batch of new prospects;
//                                 in the cloud also the auto-sender tick (replies, follow-ups, one send)
//   scheduled "0 13 * * MON-FRI"  weekday morning: queue the day's automatic emails and send the plan,
//                                 plus manual picks for businesses with no email (src/digest.js)
//   fetch  /ops, /ops/b/...       the founder's prospect board (src/board.js), served on mobiusintegration.com
//   email  ops@                   the hidden copy of an email the founder sent (marks it sent), or reply
//                                 commands: SENT / SKIP / STOP / MORE / STATUS / BOARD (src/commands.js)

import { checkSite, readCapped } from "../../shared/site-check.js";
import { planHarvest, runHarvestTile, logRun } from "./overpass.js";
import { scoreProspect } from "./score.js";
import { buildDigest, recordDigest, countReady, esc } from "./digest.js";
import { outboxTick, fillQueue, autoState, dailyPlanEmail } from "./outbox.js";
import { readRawMessage, extractPlainText, parseCommands, decodeMimeHeader, addressesIn } from "./commands.js";
import { handleOps } from "./board.js";
import { markProspect, matchSentCopy } from "./marks.js";
import { boardUrl } from "./tokens.js";
import { PROSPECTOR_UA } from "./contacts.js";
import { sendToFounder } from "./mail.js";
import { handleDiscord } from "./discord.js";

export { sendToFounder };

const CRON_HARVEST = "0 11 * * MON";
const CRON_CHECK = "*/15 * * * *";
const CRON_DIGEST = "0 13 * * MON-FRI";
const CRON_STUDIO = "* * * * *";

const HOME_PAGE_MAX_BYTES = 150 * 1024;
const ROBOTS_MAX_BYTES = 32 * 1024;

export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron === CRON_STUDIO) {
      if (env.STUDIO_ENABLED === "false") return;
      try { const { pollStudio } = await import("./studio.js"); const task = pollStudio(env); if (ctx?.waitUntil) ctx.waitUntil(task); else await task; }
      catch (e) { console.error("prospector: Studio poll failed:", e?.message || "unknown error"); }
      return;
    }
    const kind = { [CRON_HARVEST]: "harvest", [CRON_CHECK]: "check", [CRON_DIGEST]: "digest" }[controller.cron];
    if (!kind) return;
    try {
      // Harvesting only happens where HARVEST_HERE is "true": scripts/harvest-local.mjs sets it when it
      // runs this code on the founder's PC. Public Overpass servers refuse Cloudflare's network, so the
      // deployed Worker never harvests; it checks prospects and sends the digest.
      const harvestHere = env.HARVEST_HERE === "true";
      const onPc = harvestHere || env.PC_CHECK === "true";
      if (onPc) await pcHeartbeat(env.DB);
      if (kind === "harvest") { if (harvestHere) await planHarvest(env); } // no Overpass query: queues the tiles
      else if (kind === "check") {
        // While tiles are queued (local harvest), this run harvests one tile and does no checks.
        try {
          if (!(harvestHere && (await runHarvestTile(env)))) await checkBatch(env, onPc);
        } catch (e) {
          console.error("prospector: check failed:", e && e.message);
          try { await logRun(env.DB, "check", false, { error: e && e.message }); } catch {}
        }
        // The auto-sender runs in the cloud only (never during a local harvest or check run), and a
        // failed check batch never stops it.
        if (!onPc) {
          try { await outboxTick(env); } catch (e) {
            console.error("prospector: outbox failed:", e && e.message);
            try { await logRun(env.DB, "outbox", false, { error: e && e.message }); } catch {}
          }
        }
      }
      else await dailyDigest(env);
    } catch (e) {
      console.error(`prospector: ${kind} failed:`, e && e.message);
      try { await logRun(env.DB, kind, false, { error: e && e.message }); } catch {}
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/discord/interactions") {
      try { return await handleDiscord(request, env, ctx); }
      catch (e) { console.error("prospector: Discord interaction failed:", e && e.message); return new Response("Internal error", { status: 500 }); }
    }
    if (url.pathname === "/ops" || url.pathname.startsWith("/ops/")) {      try {
        return await handleOps(request, env);
      } catch (e) {
        console.error("prospector: board failed:", e && e.message);
        return new Response("Something went wrong. Try again in a minute.", { status: 500, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
      }
    }
    return new Response("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  },

  async email(message, env, ctx) {
    // The founder writes from his Gmail (FOUNDER_TO) or his Workspace address (FOUNDER_FROM).
    const founders = founderAddresses(env);
    if (!founders.length || !founders.includes(String(message.from || "").toLowerCase())) {
      message.setReject("Not accepted");
      return;
    }
    // Envelope senders can be forged. If the receiving MTA recorded a DMARC failure, don't act.
    if (/\bdmarc=fail\b/i.test(message.headers.get("authentication-results") || "")) {
      message.setReject("Not accepted");
      return;
    }
    try {
      // ops@ isn't in To or Cc: this is the hidden copy (Bcc) of an email the founder just sent from a
      // "Write email" button. Mark that prospect as sent; nothing is forwarded or replied to anyone.
      const ops = String(env.OPS_ADDRESS || "").toLowerCase();
      const visible = addressesIn(decodeMimeHeader(`${message.headers.get("to") || ""}, ${message.headers.get("cc") || ""}`));
      if (ops && !visible.includes(ops)) {
        await handleSentCopy(env, message, founders, ops);
        return;
      }
      const text = extractPlainText(await readRawMessage(message.raw));
      const { commands, unknown } = parseCommands(text);
      const report = await runCommands(env, commands, unknown);
      const subject = `Prospector: ${commands.length} command${commands.length === 1 ? "" : "s"} handled`;
      const board = await boardUrl(env);
      await sendToFounder(env, subject, `${report}\n\nYour prospect board: ${board}`,
        `<pre style="font-family:inherit;font-size:14px;white-space:pre-wrap">${esc(report)}</pre><p><a href="${esc(board)}">Open your prospect board</a></p>`);
      const { discordSend } = await import("./discord.js");
      await discordSend(env, "hq", { content: `**${subject}**\n${report}`.slice(0, 1900) });
    } catch (e) {
      console.error("prospector: email handler failed:", e && e.message);
      try { await logRun(env.DB, "email", false, { error: e && e.message }); } catch {}
    }
  },
};

const num = (v, dflt, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || dflt));

export function founderAddresses(env) {
  return [env.FOUNDER_TO, env.FOUNDER_FROM].map((a) => String(a || "").trim().toLowerCase()).filter((a) => a.includes("@"));
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
      headers: { "User-Agent": PROSPECTOR_UA, Accept: "text/plain" },
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
  // expectName: a page that never mentions the business (placeholder, resold or hijacked domain) isn't checked.
  const check = await checkSite(p.website, { maxBytes: HOME_PAGE_MAX_BYTES, userAgent: PROSPECTOR_UA, timeoutMs: 8000, httpFallback: true, expectName: p.name });
  return { p, check };
}

// Local runs (harvest-local / check-local on the founder's PC) keep this fresh while they work.
async function pcHeartbeat(db) {
  await db.prepare("INSERT INTO meta (key, value) VALUES ('pc_heartbeat', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}

export async function checkBatch(env, onPc = false) {
  const db = env.DB;
  if (!onPc) {
    // A check run on the founder's PC gets through to sites that refuse Cloudflare's network, so while
    // one is working (heartbeat in the last 10 minutes) the cloud stays out of its way.
    const busy = await db.prepare("SELECT 1 AS busy FROM meta WHERE key = 'pc_heartbeat' AND value > datetime('now', '-10 minutes')").first();
    if (busy) return;
  }
  const { results } = await db.prepare(
    `SELECT id, domain, website, name, category, phone FROM prospects
      WHERE status = 'new' AND sightings < 3 AND domain NOT IN (SELECT value FROM suppression)
      ORDER BY first_seen, id LIMIT ?`
  ).bind(num(env.CHECKS_PER_RUN, 5, 1, 25)).all();
  if (!results || !results.length) return; // idle runs cost one or two queries

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
        c.ok ? (m.https ? 1 : 0) : null, c.ok && m.viewport != null ? (m.viewport ? 1 : 0) : null, c.ok ? m.imgsTotal : null, c.ok ? m.imgsNoAlt : null, c.ok ? m.fieldsUnlabeled : null,
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

export async function sendDigest(env, limit, opts = {}) {
  if (!env.FOUNDER_TO) throw new Error("FOUNDER_TO secret is not set");
  const digest = await buildDigest(env, limit, opts);
  if (!digest) return { sent: 0 };
  await sendToFounder(env, digest.subject, digest.text, digest.html);
  const { discordSend } = await import("./discord.js");
  await discordSend(env, "hq", { content: `**${digest.subject}**\n${digest.text}`.slice(0, 1900) });
  await recordDigest(env.DB, digest.items, "digest");
  return { sent: digest.items.length, subject: digest.subject };
}

// Weekday mornings: top the board up to READY_CAP prospects waiting to be sent, and email the new ones.
// A full board gets no new picks (they'd only pile up); on Mondays it gets a reminder instead.
async function dailyDigest(env) {
  // With auto-send on: queue the day's first emails and send the founder the plan. The board's manual
  // picks are then only the businesses with no email address on their site.
  const auto = await autoState(env);
  if (auto.running) {
    try {
      const fill = await fillQueue(env);
      await logRun(env.DB, "auto_fill", true, { queued: fill.queued, ymd: fill.ymd, cap: fill.cap, reason: fill.reason, scanned: fill.scanned });
      await dailyPlanEmail(env, fill);
    } catch (e) {
      console.error("prospector: auto fill failed:", e && e.message);
      try { await logRun(env.DB, "auto_fill", false, { error: e && e.message }); } catch {}
    }
  }
  const size = auto.running ? Math.min(3, num(env.DIGEST_SIZE, 5, 1, 10)) : num(env.DIGEST_SIZE, 5, 1, 10);
  const waiting = await countReady(env.DB);
  const room = num(env.READY_CAP, 15, 1, 100) - waiting;
  if (room <= 0) {
    if (new Date().getUTCDay() === 1) await sendBoardReminder(env, waiting);
    await logRun(env.DB, "digest", true, { skipped: "board full", waiting });
    return;
  }
  const r = await sendDigest(env, Math.min(size, room), { noEmailOnly: auto.running });
  if (!r.sent) await logRun(env.DB, "digest", true, { skipped: auto.running ? "no businesses without an email are waiting" : "no checked prospects above MIN_SCORE", waiting });
}

async function sendBoardReminder(env, waiting) {
  const board = await boardUrl(env);
  const line = `${waiting} prospects are waiting on your board, so no new ones were added today. New picks resume once there's room.`;
  await sendToFounder(env, `${waiting} prospects waiting on your board`, `${line}\n\n${board}`,
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937"><p>${esc(line)}</p><p><a href="${esc(board)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#4338ca;color:#ffffff;font-weight:bold;text-decoration:none">Open your prospect board</a></p></div>`);
  const { discordSend } = await import("./discord.js");
  await discordSend(env, "hq", { content: line });
}

// ---------------------------------------------------------------------------
// The hidden copy of a sent email

async function handleSentCopy(env, message, founders, ops) {
  const to = addressesIn(decodeMimeHeader(message.headers.get("to") || "")).filter((a) => !founders.includes(a) && a !== ops).slice(0, 5);
  const subject = decodeMimeHeader(message.headers.get("subject") || "").replace(/\s+/g, " ").trim();
  const match = await matchSentCopy(env.DB, to, subject);
  let reason = "it doesn't match a prospect from your digests";
  if (match) {
    const r = await markProspect(env, match.prospectId, "sent", "gmail", { to: match.to, detail: subject.slice(0, 200) });
    if (r.ok) return;
    reason = String(r.error || "it couldn't be marked").replace(/\.$/, "");
  }
  // Tell the founder instead of guessing.
  const board = await boardUrl(env);
  const what = `${to.length ? `to ${to.join(", ")}` : "with no To address"}${subject ? `, subject "${subject.slice(0, 120)}"` : ""}`;
  const line = `The hidden copy of an email you sent (${what}) reached ${env.OPS_ADDRESS}, but nothing was marked (${reason}). If it was a prospect, tap Sent on the board.`;
  await sendToFounder(env, "Prospector: a sent email didn't match a prospect", `${line}\n\n${board}`,
    `<p>${esc(line)}</p><p><a href="${esc(board)}">Open your prospect board</a></p>`);
  const { discordSend } = await import("./discord.js");
  await discordSend(env, "approvals", { content: line });
}

// ---------------------------------------------------------------------------
// Founder commands (the reply-by-email fallback; the board's buttons do the same things)

async function runCommands(env, commands, unknown) {
  const db = env.DB;
  const lines = [];
  const byDomain = (d) => db.prepare("SELECT id FROM prospects WHERE domain = ?").bind(d).first();

  for (const c of commands) {
    const v = c.target && c.target.value;
    if (c.cmd === "SENT" || c.cmd === "SKIP") {
      const p = await byDomain(v);
      if (!p) { lines.push(`${c.cmd} ${v}: no matching prospect. Nothing changed.`); continue; }
      const r = await markProspect(env, p.id, c.cmd === "SENT" ? "sent" : "skip", "command");
      lines.push(r.ok ? `${c.cmd} ${v}: ${r.label}.` : `${c.cmd} ${v}: ${r.error}`);
    } else if (c.cmd === "STOP") {
      const ins = await db.prepare("INSERT OR IGNORE INTO suppression (value, reason) VALUES (?, 'founder STOP command')").bind(v).run();
      // A STOP for an address also parks any prospect on that address's domain.
      const p = await byDomain(c.target.kind === "email" ? v.split("@")[1] : v);
      if (p) await markProspect(env, p.id, "never", "command");
      lines.push(`STOP ${v}: ${ins.meta && ins.meta.changes ? "added to the do-not-contact list" : "already on the do-not-contact list"}${p ? "; matching prospect marked never contact." : "."}`);
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
    } else if (c.cmd === "BOARD") {
      lines.push("BOARD: your board link is below.");
    }
  }

  if (!commands.length) lines.push("I didn't find any commands in your message.");
  if (unknown.length) {
    lines.push("", "Lines I didn't understand (ignored):");
    for (const u of unknown) lines.push(`  ${u}`);
  }
  lines.push("", "Commands: SENT <domain>, SKIP <domain>, STOP <domain-or-email>, MORE, STATUS, BOARD. Put them before any quoted text. The board's buttons do the same things.");
  return lines.join("\n");
}
