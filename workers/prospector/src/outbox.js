// The auto-sender (since 2026-11-23, when the founder asked for automatic messages and follow-ups).
//
// How it works:
//   fillQueue   each weekday morning: pick prospects that have an email on their own website, draft
//               the email, and give it a send time inside the day's window (see outbox-rules.js)
//   outboxTick  every 15 minutes: ask the agent (the founder's mailbox, src/agent.js) for replies and
//               bounces, schedule follow-ups, and send at most one due email, after re-checking it
//   Follow-ups  a nudge on day 4 and a last note a week later, in the same thread, stopping the moment
//               anyone replies, bounces or asks to stop
//
// Nothing here sends unless the agent is connected (meta.agent_url and meta.agent_token) and auto-send
// isn't paused. Every send passes these checks first: the do-not-contact list, a mail domain that
// accepts email, Thanksgiving week for restaurants, and (for a prospect's own site) a fresh look at the
// page, so a finding that's gone, or a site that stopped loading, holds the email for the founder.

import { checkSite } from "../../shared/site-check.js";
import { callAgent, validAgentUrl } from "./agent.js";
import { PROSPECTOR_UA, findContact, emailBase, mxOk } from "./contacts.js";
import { findingsFor, prepareOne, parseJson, PICK_COLUMNS, NOT_PARKED, footerText, esc, typeLabel } from "./digest.js";
import { markProspect, matchSentCopy, whenLabel } from "./marks.js";
import {
  etParts, etToUtc, addDays, sqlTime, parseSql, isSendDay, nextSendDay, WINDOW, dailyCap, planSlots, restaurantHold,
  familiesOf, followupBody, classifyReply,
} from "./outbox-rules.js";

const int = (v, dflt, min, max) => Math.min(max, Math.max(min, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt));

// ---------------------------------------------------------------------------
// State (kept in the meta table)

const META_KEYS = ["agent_url", "agent_token", "auto_paused", "auto_pause_reason", "auto_first_send", "agent_cursor", "agent_status", "seen_msgs", "auto_day_block", "agent_errors"];

export async function metaSet(db, key, value) {
  if (value == null) await db.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
  else await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, String(value)).run();
}

export async function autoState(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${META_KEYS.map(() => "?").join(",")})`).bind(...META_KEYS).all();
  const m = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
  const allowLocal = env.AGENT_ALLOW_LOCAL === "true";
  const connected = !!(m.agent_url && m.agent_token && validAgentUrl(m.agent_url, allowLocal));
  return { ...m, connected, paused: m.auto_paused === "1", running: connected && m.auto_paused !== "1", allowLocal };
}

const agentCfg = (st) => ({ url: st.agent_url, token: st.agent_token, allowLocal: st.allowLocal });

export async function pauseAuto(env, reason) {
  await metaSet(env.DB, "auto_paused", "1");
  await metaSet(env.DB, "auto_pause_reason", reason);
}

async function notify(env, subject, lines, link) {
  try {
    const { sendToFounder } = await import("./mail.js");
    const { boardUrl } = await import("./tokens.js");
    const board = await boardUrl(env);
    const text = [...lines, "", `Your prospect board: ${board}`].join("\n");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:640px">${lines.map((l) => (l ? `<p style="margin:0 0 8px">${esc(l)}</p>` : "")).join("")}${link ? `<p style="margin:0 0 8px"><a href="${esc(link)}">Open the conversation in Gmail</a></p>` : ""}<p style="margin:8px 0 0"><a href="${esc(board)}">Open your prospect board</a></p></div>`;
    await sendToFounder(env, subject, text, html);
  } catch (e) {
    console.error("prospector: notify failed:", e && e.message);
  }
}

// ---------------------------------------------------------------------------
// Counting a day

async function dayCounts(db, ymd) {
  const from = sqlTime(etToUtc(ymd, 0, 0));
  const to = sqlTime(etToUtc(addDays(ymd, 1), 0, 0));
  const [a, b, c, d] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM outreach WHERE sent_via = 'auto' AND sent_at >= ? AND sent_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n FROM touches WHERE state = 'sent' AND sent_at >= ? AND sent_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n FROM outreach WHERE auto_state = 'queued' AND send_at >= ? AND send_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n FROM touches WHERE state = 'queued' AND due_at < ?").bind(to),
  ]);
  const n = (r) => (r.results && r.results[0] && r.results[0].n) || 0;
  return { sentInitial: n(a), sentFollow: n(b), queuedInitial: n(c), followDue: n(d) };
}

// The board's Auto-send panel.
export async function autoSummary(env, now = new Date()) {
  const st = await autoState(env);
  const today = etParts(now);
  const ymd = isSendDay(today.ymd) && today.h * 60 + today.min < WINDOW.end ? today.ymd : nextSendDay(today.ymd);
  const [counts, row] = await Promise.all([
    dayCounts(env.DB, ymd),
    env.DB.batch([
      env.DB.prepare("SELECT MIN(send_at) AS next, COUNT(*) AS queued FROM outreach WHERE auto_state = 'queued'"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM outreach WHERE auto_state = 'held'"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM touches WHERE state = 'queued'"),
    ]),
  ]);
  const first = (r) => (r.results && r.results[0]) || {};
  return {
    connected: st.connected, paused: st.paused, reason: st.auto_pause_reason || "",
    ymd, isToday: ymd === today.ymd, cap: dailyCap(env, st.auto_first_send, ymd),
    sent: counts.sentInitial + counts.sentFollow, queued: first(row[0]).queued || 0, next: first(row[0]).next || null,
    held: first(row[1]).n || 0, followUps: first(row[2]).n || 0,
  };
}

// ---------------------------------------------------------------------------
// Filling the queue

// An address the auto-sender may write to: on the business's own domain, or a free-mail address its site
// lists, and on a domain that accepts mail.
async function autoEmailOk(email, siteUrl) {
  return !!email && emailBase(email, siteUrl) >= 20 && (await mxOk(email.split("@")[1]));
}

async function resolveContact(env, p) {
  if (p.c_checked_at) return { email: p.c_email, url: p.c_url, form: !!p.c_form, hidden: !!p.c_hidden, auto: !!p.c_auto, error: null };
  const c = await findContact(p, { userAgent: PROSPECTOR_UA });
  // An address whose domain can't receive mail is dropped; one on an unrelated domain is kept for the
  // founder to judge, but the auto-sender won't use it.
  const email = c.email && (await mxOk(c.email.split("@")[1])) ? c.email : null;
  const auto = !!email && emailBase(email, p.final_url || p.website) >= 20;
  if (!c.error) {
    await env.DB.prepare("UPDATE prospects SET c_email=?, c_url=?, c_form=?, c_hidden=?, c_auto=?, c_checked_at=datetime('now') WHERE id=?")
      .bind(email, c.url, c.form ? 1 : 0, c.hidden ? 1 : 0, auto ? 1 : 0, p.id).run();
  }
  return { email, url: c.url, form: c.form, hidden: c.hidden, auto, error: c.error };
}

async function candidates(env, ymd, limit, kind) {
  const holdRestaurants = restaurantHold("restaurants", ymd) ? 1 : 0;
  const cols = `SELECT ${PICK_COLUMNS} FROM prospects p JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id)`;
  const common = `p.status = 'checked' AND p.sightings < 3 AND p.domain NOT IN (SELECT value FROM suppression) AND ${NOT_PARKED}
        AND (p.c_checked_at IS NULL OR p.c_auto = 1) AND NOT (p.category = 'restaurants' AND ${holdRestaurants} = 1)`;
  if (kind === "partner") {
    const { PARTNER_PRIORITY_SQL } = await import("./partners.js");
    const { results } = await env.DB.prepare(`${cols} WHERE p.track = 'partner' AND ${common} ORDER BY ${PARTNER_PRIORITY_SQL}, p.id LIMIT ?`).bind(limit).all();
    return results || [];
  }
  const { results } = await env.DB.prepare(`${cols} WHERE p.track = 'client' AND p.score >= ? AND ${common} ORDER BY p.score DESC, p.id LIMIT ?`)
    .bind(int(env.MIN_SCORE, 30, 0, 100), limit).all();
  return results || [];
}

function queueStatements(db, item, sendAt, quoted) {
  const { p, draft, full, contact } = item;
  return [
    db.prepare("INSERT INTO outreach (prospect_id, digest_date, draft_subject, draft_body, model, contact_email, contact_url, contact_form, angle, auto_state, send_at, quoted) VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)")
      .bind(p.id, new Date().toISOString().slice(0, 10), draft.subject, full, draft.model, contact.email, contact.url ? String(contact.url).slice(0, 500) : null, contact.form ? 1 : 0, draft.angle || null, sqlTime(sendAt), JSON.stringify(quoted)),
    db.prepare("UPDATE prospects SET status='digested', updated_at=datetime('now') WHERE id=? AND status='checked'").bind(p.id),
    db.prepare("INSERT INTO events (prospect_id, action, via, detail) VALUES (?, 'queued', 'auto', ?)").bind(p.id, `send ${sqlTime(sendAt)} UTC`),
  ];
}

// Fill the next sending day to its cap with first emails. Returns { queued, ymd, cap, names, reason }.
export async function fillQueue(env, { now = new Date(), maxScan = 60, rand = Math.random } = {}) {
  const db = env.DB;
  const st = await autoState(env);
  if (!st.running) return { queued: 0, reason: st.connected ? "paused" : "not connected" };

  const today = etParts(now);
  let ymd = today.ymd;
  const todayEnd = etToUtc(ymd, 15, 30);
  // Today only counts if the window still has at least an hour left (the founder gets that long to cancel).
  if (!(isSendDay(ymd) && now.getTime() + 60 * 60000 < todayEnd.getTime())) ymd = nextSendDay(ymd);
  const cap = dailyCap(env, st.auto_first_send, ymd);
  const counts = await dayCounts(db, ymd);
  const room = cap - counts.sentInitial - counts.sentFollow - counts.queuedInitial - counts.followDue;
  if (room <= 0) return { queued: 0, ymd, cap, reason: "full" };

  const start = ymd === today.ymd ? new Date(Math.max(etToUtc(ymd, 9, 30).getTime(), now.getTime() + 60 * 60000)) : etToUtc(ymd, 9, 30);
  // Pick first, then spread the picks across the whole window, so a short list isn't bunched at the start.
  const picked = []; // { adopt: row, quoted } | { item, quoted, partner }

  // 1. Drafts already on the board with an address the sender may use.
  const adopt = await db.prepare(
    `SELECT ${PICK_COLUMNS}, o.id AS oid, o.contact_email AS o_email, o.draft_subject FROM prospects p
       JOIN outreach o ON o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = p.id)
       LEFT JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id)
      WHERE p.status = 'digested' AND o.auto_state IS NULL AND o.founder_status = 'drafted' AND o.contact_email IS NOT NULL
        AND p.domain NOT IN (SELECT value FROM suppression) ORDER BY p.score DESC, p.id LIMIT 30`,
  ).all();
  for (const r of adopt.results || []) {
    if (picked.length >= room) break;
    if (restaurantHold(r.category, ymd)) continue;
    if (!(await autoEmailOk(r.o_email, r.final_url || r.website))) continue;
    picked.push({ adopt: r, quoted: r.track === "partner" ? [] : familiesOf(findingsFor(r).slice(0, 2)) });
  }

  // 2. New businesses: a partner for about every fourth place, the rest clients by score.
  const wantPartners = Math.min(Math.max(0, room - picked.length), Math.max(1, Math.round(room / 4)));
  const seen = new Set();
  let scanned = 0;
  for (const kind of ["partner", "client"]) {
    const list = await candidates(env, ymd, maxScan, kind);
    for (let i = 0; i < list.length && scanned < maxScan * 2; i += 4) {
      const partnersSoFar = () => picked.filter((x) => x.partner).length;
      if (picked.length >= room || (kind === "partner" && partnersSoFar() >= wantPartners)) break;
      const batch = list.slice(i, i + 4).filter((p) => !seen.has(p.id));
      scanned += batch.length;
      const looked = await Promise.all(batch.map((p) => resolveContact(env, p).catch(() => null)));
      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        const contact = looked[j];
        seen.add(p.id);
        if (!contact || !contact.auto) continue;
        if (picked.length >= room || (kind === "partner" && partnersSoFar() >= wantPartners)) break;
        const item = await prepareOne(env, p, contact);
        picked.push({ item, quoted: p.track === "partner" ? [] : familiesOf(item.issues.slice(0, 2)), partner: kind === "partner" });
      }
    }
  }

  const slots = planSlots(start, etToUtc(ymd, 15, 15), picked.length, rand);
  const names = [];
  for (let i = 0; i < picked.length; i++) {
    const pk = picked[i];
    const at = slots[i];
    if (pk.adopt) {
      const r = pk.adopt;
      await db.batch([
        db.prepare("UPDATE outreach SET auto_state='queued', send_at=?, quoted=?, updated_at=datetime('now') WHERE id=?").bind(sqlTime(at), JSON.stringify(pk.quoted), r.oid),
        db.prepare("INSERT INTO events (prospect_id, action, via, detail) VALUES (?, 'queued', 'auto', ?)").bind(r.id, `adopted; send ${sqlTime(at)} UTC`),
      ]);
      names.push({ name: r.name, kind: typeLabel(r), at: at.toISOString() });
    } else {
      await db.batch(queueStatements(db, pk.item, at, pk.quoted));
      names.push({ name: pk.item.p.name, kind: typeLabel(pk.item.p), at: at.toISOString() });
    }
  }
  return { queued: picked.length, ymd, cap, scanned, names };
}

// ---------------------------------------------------------------------------
// Follow-ups

export async function scheduleFollowups(env, now = new Date()) {
  const db = env.DB;
  const nowS = sqlTime(now);
  const stop = "o.replied_at IS NULL AND o.bounced_at IS NULL AND o.no_followups = 0";
  const first = await db.prepare(
    `SELECT o.id, o.prospect_id FROM outreach o JOIN prospects p ON p.id = o.prospect_id
      WHERE o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = o.prospect_id)
        AND o.founder_status = 'sent' AND p.status = 'sent' AND ${stop}
        AND o.sent_at <= ? AND o.sent_at >= ? AND COALESCE(o.sent_to, o.contact_email) IS NOT NULL
        AND p.domain NOT IN (SELECT value FROM suppression)
        AND NOT EXISTS (SELECT 1 FROM touches t WHERE t.outreach_id = o.id AND t.n = 1) LIMIT 30`,
  ).bind(sqlTime(new Date(now.getTime() - 4 * 86400000)), sqlTime(new Date(now.getTime() - 30 * 86400000))).all();
  const second = await db.prepare(
    `SELECT o.id, o.prospect_id FROM touches t JOIN outreach o ON o.id = t.outreach_id JOIN prospects p ON p.id = o.prospect_id
      WHERE t.n = 1 AND t.state = 'sent' AND t.sent_at <= ? AND p.status = 'sent' AND ${stop}
        AND p.domain NOT IN (SELECT value FROM suppression)
        AND NOT EXISTS (SELECT 1 FROM touches u WHERE u.outreach_id = o.id AND u.n = 2) LIMIT 30`,
  ).bind(sqlTime(new Date(now.getTime() - 7 * 86400000))).all();
  const stmts = [];
  for (const r of first.results || []) stmts.push(db.prepare("INSERT OR IGNORE INTO touches (outreach_id, prospect_id, n, due_at) VALUES (?, ?, 1, ?)").bind(r.id, r.prospect_id, nowS));
  for (const r of second.results || []) stmts.push(db.prepare("INSERT OR IGNORE INTO touches (outreach_id, prospect_id, n, due_at) VALUES (?, ?, 2, ?)").bind(r.id, r.prospect_id, nowS));
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// ---------------------------------------------------------------------------
// Sending

const FAMILY_NAMES = { https: "HTTPS", viewport: "mobile viewport", alt: "image descriptions", label: "form labels", booking: "online booking", slow: "page speed", title: "page title", desc: "page description" };

// Next send time after a deferral: the next allowed morning.
function nextMorning(ymd, category, rand = Math.random) {
  let d = nextSendDay(ymd);
  while (restaurantHold(category, d)) d = nextSendDay(d);
  return new Date(etToUtc(d, 10, 0).getTime() + Math.floor(rand() * 90) * 60000);
}

// Is this email still OK to send right now? -> { ok, issues } | { hold } | { cancel } | { defer }
async function preSend(env, row, now) {
  const db = env.DB;
  const email = String(row.to || "").toLowerCase();
  if (!email.includes("@")) return { hold: "There's no email address on file." };
  const dom = email.split("@")[1];
  const blocked = await db.prepare("SELECT 1 AS x FROM suppression WHERE value IN (?, ?, ?) LIMIT 1").bind(row.domain, email, dom).first();
  if (blocked) return { cancel: "They're on the do-not-contact list." };
  if (restaurantHold(row.category, etParts(now).ymd)) return { defer: true };
  if (!(await mxOk(dom))) return { hold: `${dom} doesn't accept email (no mail server).` };
  if (row.track === "partner") return { ok: true, issues: [] };
  const c = await checkSite(row.website, { maxBytes: 150 * 1024, userAgent: PROSPECTOR_UA, timeoutMs: 8000, httpFallback: true, expectName: row.name });
  if (!c.ok) return { hold: `Their website didn't load when I re-checked it${c.error ? ` (${String(c.error).slice(0, 80)})` : ""}.` };
  return { ok: true, issues: c.issues || [] };
}

async function recordFailure(env, row, kind, error) {
  const db = env.DB;
  if (kind === "initial") {
    const hold = Number(row.attempts) + 1 >= 3;
    await db.prepare("UPDATE outreach SET attempts = attempts + 1, auto_state = ?, hold_reason = ? WHERE id = ?")
      .bind(hold ? "held" : "queued", hold ? `Sending failed three times (${String(error).slice(0, 100)}).` : null, row.oid).run();
  }
  const errs = Number((await db.prepare("SELECT value FROM meta WHERE key = 'agent_errors'").first() || {}).value) || 0;
  await metaSet(db, "agent_errors", errs + 1);
  if (errs + 1 === 3) await notify(env, "Auto-send is having trouble", [`The last three automatic sends failed. The latest error: ${String(error).slice(0, 200)}`, "It will keep trying. If this continues, the Google script may need to be re-authorized."]);
}

async function sendInitial(env, st, row, now) {
  const db = env.DB;
  const pre = await preSend(env, row, now);
  if (pre.cancel) { await db.prepare("UPDATE outreach SET auto_state = 'cancelled', hold_reason = ? WHERE id = ?").bind(pre.cancel, row.oid).run(); return false; }
  if (pre.defer) {
    await db.prepare("UPDATE outreach SET send_at = ? WHERE id = ?").bind(sqlTime(nextMorning(etParts(now).ymd, row.category)), row.oid).run();
    return false;
  }
  if (pre.hold) { await db.prepare("UPDATE outreach SET auto_state = 'held', hold_reason = ? WHERE id = ?").bind(pre.hold, row.oid).run(); return false; }
  // The draft quotes findings from an earlier look at their site: every one must still be there.
  const quoted = parseJson(row.quoted, null);
  if (row.track !== "partner" && Array.isArray(quoted) && quoted.length) {
    const now_ = new Set(familiesOf(pre.issues));
    const gone = quoted.filter((f) => !now_.has(f));
    if (gone.length) {
      await db.prepare("UPDATE outreach SET auto_state = 'held', hold_reason = ? WHERE id = ?")
        .bind(`The finding about ${gone.map((f) => FAMILY_NAMES[f] || f).join(" and ")} no longer shows up on their site, so I held the email for you.`, row.oid).run();
      return false;
    }
  }
  let res;
  try {
    res = await callAgent(agentCfg(st), "send", { to: row.to, subject: row.draft_subject, body: row.draft_body, kind: "initial" });
  } catch (e) {
    await recordFailure(env, row, "initial", e && e.message);
    return false;
  }
  return afterSend(env, st, row, res, "initial", now);
}

async function sendTouch(env, st, row, now) {
  const db = env.DB;
  const pre = await preSend(env, row, now);
  if (pre.cancel) { await db.prepare("UPDATE touches SET state = 'cancelled', note = ? WHERE id = ?").bind(pre.cancel, row.tid).run(); return false; }
  if (pre.defer) { await db.prepare("UPDATE touches SET due_at = ? WHERE id = ?").bind(sqlTime(nextMorning(etParts(now).ymd, row.category)), row.tid).run(); return false; }
  if (pre.hold) { await db.prepare("UPDATE touches SET due_at = ?, note = ? WHERE id = ?").bind(sqlTime(new Date(now.getTime() + 86400000)), pre.hold, row.tid).run(); return false; }
  let extra = null;
  if (row.track !== "partner" && row.n === 1) {
    const quoted = parseJson(row.quoted, []) || [];
    const current = findingsFor({ issues_json: JSON.stringify(pre.issues), category: row.category });
    const still = new Set(familiesOf(current));
    // They fixed everything we mentioned: nothing left to follow up about.
    if (quoted.length && quoted.every((f) => !still.has(f))) {
      await db.prepare("UPDATE touches SET state = 'cancelled', note = 'they appear to have fixed it' WHERE outreach_id = ? AND state = 'queued'").bind(row.oid).run();
      return false;
    }
    // A second finding only when we know which ones the first email quoted; otherwise a plain nudge.
    extra = quoted.length ? current.find((i) => !quoted.some((f) => familiesOf([i]).includes(f))) || null : null;
  }
  const body = `${followupBody({ n: row.n, kind: row.track === "partner" ? "partner" : "client", name: row.name, extra })}\n\n${footerText(env)}`;
  let res;
  try {
    res = await callAgent(agentCfg(st), "send", { to: row.to, subject: row.draft_subject, body, kind: "followup", followUp: true, threadId: row.thread_ref || null });
  } catch (e) {
    await recordFailure(env, row, "touch", e && e.message);
    return false;
  }
  return afterSend(env, st, row, res, "touch", now, body);
}

async function afterSend(env, st, row, res, kind, now, body) {
  const db = env.DB;
  const id = row.prospect_id;
  if (res && res.ok) {
    await metaSet(db, "agent_errors", 0);
    if (kind === "initial") {
      const m = await markProspect(env, id, "sent", "auto", { to: row.to, detail: row.draft_subject });
      await db.prepare("UPDATE outreach SET auto_state = 'sent', thread_ref = ?, attempts = attempts + 1, hold_reason = NULL WHERE id = ?").bind(res.thread_id || null, row.oid).run();
      if (!m.ok) console.error("prospector: sent but couldn't mark:", m.error);
      if (!st.auto_first_send) await metaSet(db, "auto_first_send", etParts(now).ymd);
    } else {
      await db.batch([
        db.prepare("UPDATE touches SET state = 'sent', sent_at = datetime('now'), body = ?, subject = ? WHERE id = ?").bind(body, `Re: ${row.draft_subject}`, row.tid),
        db.prepare("INSERT INTO events (prospect_id, action, via, detail) VALUES (?, 'followup', 'auto', ?)").bind(id, `follow-up ${row.n} to ${row.to}`),
      ]);
      if (res.thread_id && !row.thread_ref) await db.prepare("UPDATE outreach SET thread_ref = ? WHERE id = ?").bind(res.thread_id, row.oid).run();
    }
    return true;
  }
  if (res && res.replied) {
    await markProspect(env, id, "replied", "agent", { detail: "reply found in the thread before a follow-up" });
    return false;
  }
  const error = (res && res.error) || "unknown error";
  if (/daily (limit|ceiling)/i.test(error)) { await metaSet(db, "auto_day_block", etParts(now).ymd); return false; }
  await recordFailure(env, row, kind, error);
  return false;
}

// Every 15 minutes (cloud only). Reads replies and bounces, schedules follow-ups, and sends at most one
// due email inside the sending window.
export async function outboxTick(env, { now = new Date() } = {}) {
  const db = env.DB;
  const st = await autoState(env);
  if (!st.connected) return { skipped: "not connected" };
  try { await pollEvents(env, st, now); } catch (e) { console.error("prospector: poll failed:", e && e.message); await metaSet(db, "agent_status", JSON.stringify({ ok: false, at: now.toISOString(), error: String(e && e.message).slice(0, 160) })); }
  await scheduleFollowups(env, now);
  if (st.paused) return { skipped: "paused" };

  const p = etParts(now);
  const mins = p.h * 60 + p.min;
  if (!isSendDay(p.ymd) || mins < WINDOW.start || mins > WINDOW.end) return { skipped: "outside the sending window" };
  if (st.auto_day_block === p.ymd) return { skipped: "the agent's daily limit was reached" };
  const counts = await dayCounts(db, p.ymd);
  if (counts.sentInitial + counts.sentFollow >= dailyCap(env, st.auto_first_send, p.ymd)) return { skipped: "daily cap reached" };

  const nowS = sqlTime(now);
  // Follow-ups first: they're already late for people we told we would.
  const touches = await db.prepare(
    `SELECT t.id AS tid, t.n, o.id AS oid, o.prospect_id, o.draft_subject, o.quoted, o.thread_ref, COALESCE(o.sent_to, o.contact_email) AS "to",
            p.domain, p.website, p.name, p.category, p.track, p.kind
       FROM touches t JOIN outreach o ON o.id = t.outreach_id JOIN prospects p ON p.id = t.prospect_id
      WHERE t.state = 'queued' AND t.due_at <= ? AND p.status = 'sent' AND o.replied_at IS NULL AND o.bounced_at IS NULL AND o.no_followups = 0
      ORDER BY t.due_at, t.id LIMIT 3`,
  ).bind(nowS).all();
  for (const row of touches.results || []) {
    if (await sendTouch(env, st, row, now)) return { sent: "followup", name: row.name };
  }
  const initials = await db.prepare(
    `SELECT o.id AS oid, o.prospect_id, o.draft_subject, o.draft_body, o.quoted, o.attempts, o.contact_email AS "to",
            p.domain, p.website, p.name, p.category, p.track, p.kind
       FROM outreach o JOIN prospects p ON p.id = o.prospect_id
      WHERE o.auto_state = 'queued' AND o.send_at <= ? AND p.status = 'digested'
      ORDER BY o.send_at, o.id LIMIT 3`,
  ).bind(nowS).all();
  for (const row of initials.results || []) {
    if (await sendInitial(env, st, row, now)) return { sent: "initial", name: row.name };
  }
  return { sent: null };
}

// ---------------------------------------------------------------------------
// Replies and bounces (read by the agent from the founder's mailbox)

async function pollEvents(env, st, now) {
  const db = env.DB;
  const since = st.agent_cursor || new Date(now.getTime() - 3600000).toISOString();
  const { results } = await db.prepare(
    `SELECT DISTINCT lower(COALESCE(sent_to, contact_email)) AS a FROM outreach WHERE founder_status = 'sent' AND sent_at >= ? AND COALESCE(sent_to, contact_email) IS NOT NULL LIMIT 100`,
  ).bind(sqlTime(new Date(now.getTime() - 30 * 86400000))).all();
  const res = await callAgent(agentCfg(st), "poll", { since, watch: (results || []).map((r) => r.a) });
  if (!res || !res.ok) throw new Error((res && res.error) || "the agent didn't answer the poll");
  const seen = new Set(parseJson(st.seen_msgs, []));
  const fresh = (res.events || []).filter((e) => e && e.id && !seen.has(e.id));
  for (const e of fresh) {
    try { await handleEvent(env, e); } catch (err) { console.error("prospector: event failed:", err && err.message); }
    seen.add(e.id);
  }
  await metaSet(db, "seen_msgs", JSON.stringify([...seen].slice(-300)));
  await metaSet(db, "agent_cursor", res.now || now.toISOString());
  await metaSet(db, "agent_status", JSON.stringify({ ok: true, at: now.toISOString(), me: res.me || null, events: fresh.length }));
  await checkBounceRate(env, now);
}

const gmailLink = (env, threadId) => (threadId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(env.FOUNDER_FROM || "")}#all/${encodeURIComponent(threadId)}` : null);

async function handleEvent(env, e) {
  const db = env.DB;
  if (e.type === "bounce") {
    const to = String(e.to || "").toLowerCase();
    if (!to.includes("@")) return;
    const row = await db.prepare("SELECT o.id AS oid, o.prospect_id AS pid, p.name FROM outreach o JOIN prospects p ON p.id = o.prospect_id WHERE lower(COALESCE(o.sent_to, o.contact_email)) = ? ORDER BY o.id DESC LIMIT 1").bind(to).first();
    await db.prepare("INSERT OR IGNORE INTO suppression (value, reason) VALUES (?, 'bounced')").bind(to).run();
    if (!row) return;
    await db.batch([
      db.prepare("UPDATE outreach SET bounced_at = COALESCE(bounced_at, datetime('now')) WHERE id = ?").bind(row.oid),
      db.prepare("UPDATE touches SET state = 'cancelled', note = 'bounced' WHERE outreach_id = ? AND state = 'queued'").bind(row.oid),
      db.prepare("INSERT INTO events (prospect_id, action, via, detail) VALUES (?, 'bounce', 'agent', ?)").bind(row.pid, String(e.reason || "").slice(0, 200)),
    ]);
    return;
  }
  if (e.type !== "reply") return;
  const from = String(e.from || "").toLowerCase();
  let match = e.thread_id ? await db.prepare("SELECT prospect_id AS prospectId FROM outreach WHERE thread_ref = ? ORDER BY id DESC LIMIT 1").bind(e.thread_id).first() : null;
  if (!match && from.includes("@")) match = await matchSentCopy(db, [from], e.subject);
  if (!match) return; // not one of ours
  const p = await db.prepare("SELECT id, name, domain FROM prospects WHERE id = ?").bind(match.prospectId).first();
  if (!p) return;
  const kind = classifyReply({ subject: e.subject, text: e.text, auto: !!e.auto });
  const snippet = String(e.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const link = gmailLink(env, e.thread_id);
  if (kind === "auto") {
    await db.prepare("INSERT INTO events (prospect_id, action, via, detail) VALUES (?, 'auto-reply', 'agent', ?)").bind(p.id, snippet.slice(0, 120)).run();
    return;
  }
  if (kind === "stop" || kind === "angry") {
    if (from.includes("@")) await db.prepare("INSERT OR IGNORE INTO suppression (value, reason) VALUES (?, ?)").bind(from, `reply: ${kind}`).run();
    await markProspect(env, p.id, "never", "agent", { detail: snippet.slice(0, 200) });
    if (kind === "angry") {
      await pauseAuto(env, `A reply from ${p.name} sounded upset.`);
      await notify(env, `Auto-send paused: ${p.name} replied angrily`, [`${p.name} replied: "${snippet}"`, "Auto-send is paused until you've read it. They're on the do-not-contact list. Resume it from the board when you're ready."], link);
    } else {
      await notify(env, `${p.name} asked us to stop`, [`${p.name} replied: "${snippet}"`, "They're on the do-not-contact list and won't get anything more."], link);
    }
    return;
  }
  await markProspect(env, p.id, "replied", "agent", { detail: snippet.slice(0, 200) });
  await notify(env, `Reply from ${p.name}`, [`${p.name} replied: "${snippet}"`, "Follow-ups to them are cancelled. Answer from your Gmail."], link);
}

// If the first emails are bouncing, stop and tell the founder: bounces are what hurt a sender's reputation.
async function checkBounceRate(env, now) {
  const db = env.DB;
  const since = sqlTime(new Date(now.getTime() - 14 * 86400000));
  const r = await db.prepare("SELECT COUNT(*) AS sent, SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced FROM outreach WHERE sent_via = 'auto' AND sent_at >= ?").bind(since).first();
  const sent = (r && r.sent) || 0;
  const bounced = (r && r.bounced) || 0;
  const st = await autoState(env);
  if (!st.paused && sent >= 10 && bounced / sent > 0.05) {
    await pauseAuto(env, `${bounced} of the last ${sent} automatic emails bounced.`);
    await notify(env, "Auto-send paused: too many bounces", [`${bounced} of the last ${sent} automatic emails bounced (more than 5%).`, "Bounces hurt the mailbox's reputation, so I stopped. Resume it from the board once you've looked."]);
  }
}

// ---------------------------------------------------------------------------
// The morning email: what goes out today

export async function dailyPlanEmail(env, fill) {
  const db = env.DB;
  const board = await (await import("./tokens.js")).boardUrl(env);
  const { sendToFounder } = await import("./mail.js");
  const st = await autoState(env);
  const sum = await autoSummary(env);
  const { results } = await db.prepare(
    `SELECT p.name, o.send_at, 'first email' AS what FROM outreach o JOIN prospects p ON p.id = o.prospect_id WHERE o.auto_state = 'queued'
     UNION ALL SELECT p.name, t.due_at, 'follow-up ' || t.n FROM touches t JOIN prospects p ON p.id = t.prospect_id WHERE t.state = 'queued'
     ORDER BY 2 LIMIT 40`,
  ).all();
  const lines = (results || []).map((r) => `${whenLabel(r.send_at)}  ${r.name} (${r.what})`);
  const subject = lines.length ? `${lines.length} emails queued to go out automatically` : "Auto-send: nothing queued";
  const intro = `Auto-send is ${st.paused ? "PAUSED" : "on"}. It sends weekdays between 9:30 AM and 3:30 PM Eastern, up to ${sum.cap} a day${fill && fill.queued ? `; ${fill.queued} new ones were just queued` : ""}. Open the board to cancel any of them.`;
  const text = [subject, "", intro, "", ...(lines.length ? lines : ["(nothing queued)"]), "", `Your prospect board: ${board}`].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:640px"><h1 style="font-size:20px;margin:0 0 6px">${esc(subject)}</h1><p style="margin:0 0 10px;color:#4b5563">${esc(intro)}</p>${lines.length ? `<ul style="margin:0 0 12px;padding-left:20px">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}<p style="margin:0"><a href="${esc(board)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#4338ca;color:#ffffff;font-weight:bold;text-decoration:none">Open your prospect board</a></p></div>`;
  await sendToFounder(env, subject, text, html);
}
