// The prospect board: https://mobiusintegration.com/ops/b/<expiry>/<signature>
// One page with every prospect from the digests and tap buttons (Sent, Skip, Never contact, They
// replied, Undo) instead of reply commands. The link is signed (src/tokens.js) and only ever sent to
// the founder. Pages are never cached or indexed, send no Referer to the sites they link to, and allow
// only their own inline script and style (CSP nonce).
//
//   GET  /ops                        the permanent address: a remembered device goes straight to a fresh
//                                    board link; anyone else gets one button, "Email me a fresh link"
//   POST /ops/link                   email a fresh board link to the founder (only ever to FOUNDER_TO;
//                                    one per 10 minutes, at most 5 a day)
//   GET  /ops/b/<exp>/<sig>          the board (?do=<action>&id=<n> applies a digest button, undoable);
//                                    remembers this device (src/tokens.js)
//   POST /ops/b/<exp>/<sig>/mark     {"id": n, "action": "sent|skip|never|replied|unreplied|undo"}
//   POST /ops/b/<exp>/<sig>/more     draft DIGEST_SIZE more prospects onto the board (no email)
//   POST /ops/b/<exp>/<sig>/auto     {"action": "pause|resume|fill"}: the auto-send panel
//   POST /ops/b/<exp>/<sig>/writeup  {"id": n}: make the write-up PDF for prospect n (src/writeup.js)
//   GET  /ops/b/<exp>/<sig>/writeup/<w>  write-up w's PDF

import { checkBoard, checkDevice, deviceCookie, boardPath, boardUrl, homeUrl, homeText } from "./tokens.js";
import { markProspect, statusLabel, ACTIONS, whenLabel } from "./marks.js";
import { esc, button, formText, typeLabel, PARTNER_NOTE, findingsFor, prepareItems, recordDigest } from "./digest.js";
import { composeLinks, platformOf, writeLink } from "./compose.js";
import { hostOf } from "./contacts.js";
import { sendToFounder } from "./mail.js";
import { autoSummary, fillQueue, autoState, metaSet, pauseAuto } from "./outbox.js";
import { createWriteup, writeupPdf } from "./writeup.js";
import { PARTNER_KINDS, isLawFirm } from "./partners.js";
import { setupDiscord, discordApi, discordSend, saveBotKey } from "./discord.js";

const ROUTE = /^\/ops\/b\/(\d{9,11})\/([A-Za-z0-9_-]{43})(?:\/(mark|more|auto|discord|say|tasks|task|writeup|brandkit|texture)(?:\/([A-Za-z0-9_-]{1,80}))?)?\/?$/;
const num = (v, dflt, min, max) => Math.min(max, Math.max(min, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt));
const isGet = (request) => request.method === "GET" || request.method === "HEAD";
// The page's own script sends JSON. A form on another site can't (that would need a CORS preflight,
// which this Worker never approves), so requiring it also blocks cross-site posts.
const isJson = (request) => (request.headers.get("content-type") || "").toLowerCase().startsWith("application/json");

export async function handleOps(request, env) {
  const url = new URL(request.url);
  const cookie = request.headers.get("cookie");

  if (url.pathname === "/ops" || url.pathname === "/ops/") {
    if (!isGet(request)) return json(405, { ok: false, error: "Use GET." });
    if ((await checkDevice(env, cookie)) === "ok") return toFreshBoard(env, url);
    return linkPage(env, 200, "Prospect board", "This phone or computer hasn't opened the board lately.");
  }
  if (url.pathname === "/ops/link") {
    if (request.method !== "POST") return json(405, { ok: false, error: "Use POST." });
    if (!isJson(request)) return json(415, { ok: false, error: "Send JSON." });
    const r = await emailBoardLink(env);
    return json(r.ok ? 200 : 500, r);
  }

  const m = ROUTE.exec(url.pathname);
  if (!m) return notFound();
  const verdict = await checkBoard(env, m[1], m[2]);
  const sub = m[3];
  if (verdict !== "ok") {
    // A bookmarked or Home Screen board whose link has passed its date still opens on a remembered device.
    if (!sub && isGet(request) && (await checkDevice(env, cookie)) === "ok") return toFreshBoard(env, url);
    if (sub) return verdict === "bad" ? json(404, { ok: false, error: "Not found." }) : json(410, { ok: false, error: "This board link has expired. Reload the page for a fresh one." });
    if (verdict === "bad") return notFound();
    return linkPage(env, 410, "This board link has expired", "Get a fresh one by email, or use the board button in the newest prospects email.");
  }
  const base = `/ops/b/${m[1]}/${m[2]}`;

  if (sub === "brandkit" || sub === "texture") {
    if (request.method !== "GET") return json(405, { ok: false, error: "Use GET." });
    if (sub === "brandkit") {
      const value = await env.WRITEUPS.get("brand/kit.json");
      if (!value) return json(404, { ok: false, error: "Brand kit has not been handed off." });
      return new Response(value, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const key = m[4];
    if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return json(404, { ok: false, error: "Not found." });
    const value = await env.WRITEUPS.get(`brand/texture/${key}`, { type: "arrayBuffer" });
    return value ? new Response(value, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } }) : json(404, { ok: false, error: "Not found." });
  }

  if (!sub) {
    if (!isGet(request)) return json(405, { ok: false, error: "Use GET." });
    const page = await boardPage(env, base, platformOf(request.headers.get("user-agent")));
    page.headers.append("Set-Cookie", await deviceCookie(env));
    return page;
  }
  if (sub === "discord") {
    if (request.method !== "POST" || !isJson(request)) return json(405, { ok: false, error: "Use a JSON POST." });
    let body; try { body = await request.json(); } catch { return json(400, { ok: false, error: "Bad request." }); }
    // The same action saves a pasted bot key (checked with Discord first) or runs the channel setup.
    const r = body.key !== undefined ? await saveBotKey(env, String(body.key || "")) : await setupDiscord(env, String(body.guild_id || ""));
    return json(r.ok ? 200 : 400, r);
  }
  if (sub === "say") {
    if (request.method !== "POST" || !isJson(request)) return json(405, { ok: false, error: "Use a JSON POST." });
    let body; try { body = await request.json(); } catch { return json(400, { ok: false, error: "Bad request." }); }
    if (!body || !["builds", "hq"].includes(body.channel) || typeof body.content !== "string" || body.content.length > 1900 || !body.content.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body.content)) return json(400, { ok: false, error: "Bad request." });
    const sent = await discordSend(env, body.channel, { content: body.content });
    return json(sent ? 200 : 502, { ok: !!sent });
  }
  if (sub === "tasks" && request.method === "GET") {
    try {
      const cfg = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first();
      const discord = JSON.parse(cfg?.value || "{}");
      const forumId = discord.channels?.tasks;
      if (!discord.guild || !forumId) return json(200, []);
      const [forum, active] = await Promise.all([
        discordApi(env, `/channels/${forumId}`),
        discordApi(env, `/guilds/${discord.guild}/threads/active`),
      ]);
      const approvedTag = (forum.available_tags || []).find((tag) => tag.name === "approved");
      const threads = (active.threads || []).filter((thread) => thread.parent_id === forumId && approvedTag && (thread.applied_tags || []).includes(approvedTag.id));
      const tasks = await Promise.all(threads.map(async (thread) => {
        const messages = await discordApi(env, `/channels/${thread.id}/messages?around=${thread.id}&limit=1`);
        const first = Array.isArray(messages) ? messages[0] : null;
        return { id: thread.id, title: thread.name || "", firstMessage: first?.content || "", url: `https://discord.com/channels/${discord.guild}/${thread.id}` };
      }));
      return json(200, tasks);
    } catch (e) { console.error("prospector: Discord task list failed:", e.message); return json(502, { ok: false, error: "Couldn't load tasks." }); }
  }
  if (sub === "task") {
    if (request.method !== "POST" || !isJson(request)) return json(405, { ok: false, error: "Use a JSON POST." });
    let body; try { body = await request.json(); } catch { return json(400, { ok: false, error: "Bad request." }); }
    if (!body || typeof body.id !== "string" || !/^\d{17,20}$/.test(body.id) || !["in-progress", "review", "done"].includes(body.status) || typeof body.message !== "string" || body.message.length > 1900 || !body.message.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body.message)) return json(400, { ok: false, error: "Bad request." });
    try {
      const row = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first();
      const discord = JSON.parse(row?.value || "{}");
      const forumId = discord.channels?.tasks;
      if (!forumId) return json(400, { ok: false, error: "Discord tasks are not configured." });
      const forum = await discordApi(env, `/channels/${forumId}`);
      const statusTag = (forum.available_tags || []).find((tag) => tag.name === body.status);
      const thread = await discordApi(env, `/channels/${body.id}`);
      if (!statusTag || thread.parent_id !== forumId) return json(400, { ok: false, error: "Invalid task." });
      const sent = await discordApi(env, `/channels/${body.id}/messages`, "POST", { content: body.message, allowed_mentions: { parse: [] } });
      if (!sent) return json(502, { ok: false, error: "Couldn't post task update." });
      const stateIds = (forum.available_tags || []).filter((tag) => ["proposed", "approved", "in-progress", "review", "done"].includes(tag.name)).map((tag) => tag.id);
      const applied = (thread.applied_tags || []).filter((id) => !stateIds.includes(id));
      applied.push(statusTag.id);
      await discordApi(env, `/channels/${body.id}`, "PATCH", { applied_tags: applied });
      return json(200, { ok: true });
    } catch (e) { console.error("prospector: Discord task update failed:", e.message); return json(502, { ok: false, error: "Couldn't update task." }); }
  }
  if (m[4]) {
    // Only a write-up has an id in its address: GET /writeup/<id> is the PDF.
    if (sub !== "writeup") return notFound();
    if (!isGet(request)) return json(405, { ok: false, error: "Use GET." });
    const pdf = await writeupPdf(env, Number(m[4]));
    if (!pdf) return notFound();
    return new Response(pdf.bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pdf.filename.replace(/["\\]/g, "")}"`,
        "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (request.method !== "POST") return json(405, { ok: false, error: "Use POST." });
  if (!isJson(request)) return json(415, { ok: false, error: "Send JSON." });

  if (sub === "writeup") {
    let body;
    try { body = await request.json(); } catch { return json(400, { ok: false, error: "Bad request." }); }
    const id = Number(body && body.id);
    if (!Number.isInteger(id) || id <= 0) return json(400, { ok: false, error: "Bad request." });
    const r = await createWriteup(env, id, { via: "board" });
    if (!r.ok) return json(200, { ok: false, error: `The write-up didn't work: ${r.error}` });
    return json(200, { ok: true, id: r.id, url: `${base}/writeup/${r.id}`, findings: (r.findings || []).length });
  }

  if (sub === "mark") {
    let body;
    try { body = await request.json(); } catch { return json(400, { ok: false, error: "Bad request." }); }
    const id = Number(body && body.id);
    const action = String((body && body.action) || "");
    if (!Number.isInteger(id) || id <= 0 || !ACTIONS.has(action)) return json(400, { ok: false, error: "Bad request." });
    const via = body.via === "email-button" ? "email-button" : "board";
    const r = await markProspect(env, id, action, via);
    return json(r.ok ? 200 : 409, r);
  }

  if (sub === "auto") {
    let body;
    try { body = await request.json(); } catch { return json(400, { ok: false, error: "Bad request." }); }
    const action = String((body && body.action) || "");
    try {
      if (action === "pause") {
        await pauseAuto(env, "Paused from your board.");
        return json(200, { ok: true, message: "Auto-send is paused. Nothing more goes out until you resume it." });
      }
      if (action === "resume") {
        await metaSet(env.DB, "auto_paused", null);
        await metaSet(env.DB, "auto_pause_reason", null);
        return json(200, { ok: true, message: "Auto-send is on." });
      }
      if (action === "fill") {
        const r = await fillQueue(env, { maxScan: 24 });
        const message = r.queued
          ? `${r.queued} more queued.`
          : r.reason === "full" ? "The queue is already full for the next sending day. More goes out after that."
          : r.reason === "paused" ? "Auto-send is paused. Resume it first."
          : r.reason === "not connected" ? "Auto-send isn't connected to your mailbox yet."
          : "No more businesses with an email address are ready right now.";
        return json(200, { ok: true, queued: r.queued, message });
      }
    } catch (e) {
      console.error("prospector: board auto failed:", e && e.message);
      return json(500, { ok: false, error: "That didn't work. Try again in a minute." });
    }
    return json(400, { ok: false, error: "Bad request." });
  }

  // sub === "more"
  try {
    // With auto-send on, Get more tops up the automatic queue, and drafts cards only for businesses with no email.
    const auto = await autoState(env);
    const queued = auto.running ? (await fillQueue(env, { maxScan: 24 })).queued : 0;
    const items = await prepareItems(env, num(env.DIGEST_SIZE, 5, 1, 10), { noEmailOnly: auto.running });
    if (items.length) await recordDigest(env.DB, items, "board");
    return json(200, { ok: true, added: items.length + queued, queued });
  } catch (e) {
    console.error("prospector: board more failed:", e && e.message);
    return json(500, { ok: false, error: "Couldn't draft more right now. Try again in a minute." });
  }
}

// ---------------------------------------------------------------------------
// Data

const COLUMNS = `p.id, p.domain, p.website, p.name, p.category, p.kind, p.track, p.city, p.phone, p.score, p.status, p.updated_at,
       o.digest_date, o.draft_subject, o.draft_body, o.contact_email, o.contact_url, o.contact_form, o.sent_at, o.sent_via, o.replied_at,
       o.auto_state, o.send_at, o.hold_reason, o.bounced_at, o.no_followups, o.sent_to,
       (SELECT COUNT(*) FROM touches t WHERE t.outreach_id = o.id AND t.state = 'sent') AS fu_sent,
       (SELECT MIN(due_at) FROM touches t WHERE t.outreach_id = o.id AND t.state = 'queued') AS fu_due,
       c.issues_json, c.final_url
  FROM prospects p
  JOIN outreach o ON o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = p.id)
  LEFT JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id)`;

async function loadBoard(env) {
  const db = env.DB;
  const [ready, done, stats, writeups, replies, results] = await db.batch([
    db.prepare(`SELECT ${COLUMNS} WHERE p.status = 'digested' ORDER BY p.score DESC, p.id LIMIT 60`),
    db.prepare(`SELECT ${COLUMNS} WHERE p.status IN ('sent','skipped','suppressed') AND p.updated_at >= datetime('now','-30 days') ORDER BY p.updated_at DESC LIMIT 60`),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM outreach WHERE founder_status = 'sent' AND COALESCE(sent_at, updated_at) >= datetime('now','-7 days')) AS sent7,
         (SELECT COUNT(*) FROM outreach WHERE founder_status = 'sent') AS sent_all,
         (SELECT COUNT(*) FROM outreach WHERE replied_at IS NOT NULL) AS replies,
         (SELECT COUNT(*) FROM prospects WHERE status = 'checked' AND track = 'client' AND sightings < 3 AND score >= ? AND domain NOT IN (SELECT value FROM suppression)) AS pool,
         (SELECT COUNT(*) FROM prospects WHERE status = 'checked' AND track = 'partner' AND sightings < 3 AND domain NOT IN (SELECT value FROM suppression)) AS partners`,
    ).bind(num(env.MIN_SCORE, 30, 0, 100)),
    // The newest write-up and the newest reply for each prospect (the reply kit, src/replykit.js).
    db.prepare("SELECT prospect_id, MAX(id) AS wid FROM writeups WHERE kv_key IS NOT NULL AND created_at >= datetime('now', '-120 days') GROUP BY prospect_id"),
    db.prepare("SELECT r.prospect_id, r.state, r.intent, r.thread_id, r.text, r.note FROM replies r WHERE r.id IN (SELECT MAX(id) FROM replies GROUP BY prospect_id)"),
    // Every business emailed so far, for the results panel.
    db.prepare(
      `SELECT p.track, p.kind, p.category, p.name, o.variant, o.replied_at IS NOT NULL AS replied, o.bounced_at IS NOT NULL AS bounced,
              EXISTS (SELECT 1 FROM replies r WHERE r.prospect_id = p.id AND r.intent IN ('yes', 'question', 'call')) AS interested
         FROM outreach o JOIN prospects p ON p.id = o.prospect_id
        WHERE o.founder_status = 'sent' AND o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = p.id)`,
    ),
  ]);
  return {
    results: results.results || [],
    ready: ready.results || [], done: done.results || [], stats: (stats.results && stats.results[0]) || {},
    writeups: new Map((writeups.results || []).map((w) => [w.prospect_id, w.wid])),
    replies: new Map((replies.results || []).map((r) => [r.prospect_id, r])),
  };
}

// ---------------------------------------------------------------------------
// Rendering

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function contactLine(r) {
  const site = r.final_url || r.website;
  if (r.contact_email) return `Email on their site: <strong>${esc(r.contact_email)}</strong>`;
  if (r.contact_url) {
    return `No email on their site. Use their <a href="${esc(r.contact_url)}" target="_blank" rel="noopener noreferrer">contact page</a>${r.contact_form ? " (it has a form)" : ""}, then tap Sent.`;
  }
  if (r.contact_form == null) return `Contact not looked up yet. Check <a href="${esc(site)}" target="_blank" rel="noopener noreferrer">their site</a>.`;
  return `No email or contact page found automatically. Check <a href="${esc(site)}" target="_blank" rel="noopener noreferrer">their site</a>, or call.`;
}

const REPLY_STATE = {
  new: "Preparing a draft answer (a few minutes).",
  drafting: "Preparing a draft answer (a few minutes).",
  drafted: "A draft answer is waiting in that Gmail thread. Read it, change anything you like, and tap Send.",
  skipped: "Answer from your Gmail.",
};

function replyBlock(r, rep, env) {
  if (!rep) return "";
  const text = String(rep.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const state = rep.state === "failed" ? `I couldn't prepare a draft answer (${rep.note || "an error"}). Answer from your Gmail.` : REPLY_STATE[rep.state] || "";
  const gmail = rep.thread_id ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(env.FOUNDER_FROM || "")}#all/${encodeURIComponent(rep.thread_id)}` : "";
  return `<div class="reply"><p><strong>They wrote:</strong> “${esc(text)}”</p>${state ? `<p class="muted">${esc(state)}</p>` : ""}${gmail ? `<div class="row"><a class="btn primary" href="${esc(gmail)}" target="_blank" rel="noopener noreferrer">Open in Gmail</a></div>` : ""}</div>`;
}

function writeupRow(r, wid, base) {
  if (r.track === "partner") return "";
  return `<div class="row wrow">${wid
    ? `<a class="btn" href="${esc(`${base}/writeup/${wid}`)}" target="_blank" rel="noopener noreferrer">Open write-up (PDF)</a><button type="button" class="btn small" data-writeup="1">Make a fresh one</button>`
    : `<button type="button" class="btn" data-writeup="1">Make write-up (PDF)</button>`}</div>`;
}

function card(r, env, platform, ctx = {}) {
  const site = r.final_url || r.website;
  const partner = r.track === "partner";
  const rep = ctx.replies ? ctx.replies.get(r.id) : null;
  const wid = ctx.writeups ? ctx.writeups.get(r.id) : null;
  const issues = partner ? [] : findingsFor(r).slice(0, 4);
  const links = composeLinks(env, { to: r.contact_email, subject: r.draft_subject, body: r.draft_body });
  const write = writeLink(links, platform);
  const tel = r.phone ? String(r.phone).replace(/[^\d+]/g, "") : "";
  const auto = r.status === "digested" && (r.auto_state === "queued" || r.auto_state === "held") ? r.auto_state : "";
  return `<article class="card" id="p${r.id}" data-id="${r.id}" data-status="${esc(r.status)}" data-replied="${r.replied_at ? 1 : 0}" data-nofollow="${r.no_followups ? 1 : 0}"${auto ? ` data-auto="${auto}"` : ""}>
<div class="card-head"><h3>${esc(r.name)}</h3><span class="chip${partner ? " partner" : ""}">${partner ? "Referral partner" : `Score ${esc(r.score)}`}</span></div>
<p class="meta">${esc(typeLabel(r))}${r.city ? ` · ${esc(r.city)}` : ""}${tel ? ` · <a href="tel:${esc(tel)}">${esc(r.phone)}</a>` : ""}</p>
<p class="meta"><a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(site) || r.domain)}</a></p>
${partner ? `<p class="pnote">${esc(PARTNER_NOTE)}</p>` : ""}
${issues.length ? `<ul class="findings">${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
<p class="contact">${contactLine(r)}</p>
<details class="draft"><summary>Draft: ${esc(r.draft_subject)}</summary><pre>${esc(r.draft_body)}</pre><button type="button" class="btn small" data-copy="${esc(formText(r.draft_body))}">Copy message</button></details>
<div class="row when-ready"><a class="btn primary" href="${esc(write.href)}"${write.newTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>Write in Gmail</a><a class="btn" href="${esc(links.mailto)}">Other mail app</a></div>
<div class="row when-ready"><button type="button" class="btn" data-act="sent">Sent ✓</button><button type="button" class="btn" data-act="skip">Skip</button><button type="button" class="btn danger" data-act="never">Never contact</button></div>
<div class="row when-auto"><button type="button" class="btn" data-act="cancel">Cancel this send</button><button type="button" class="btn danger" data-act="never">Never contact</button></div>
<div class="row when-sent"><button type="button" class="btn" data-act="replied">They replied</button><button type="button" class="btn" data-act="unreplied">Not a reply</button><button type="button" class="btn" data-act="nofollow">Stop follow-ups</button><button type="button" class="btn" data-act="follow">Resume follow-ups</button><button type="button" class="btn danger" data-act="never">Never contact</button><button type="button" class="btn" data-act="undo">Undo</button></div>
<div class="row when-closed"><button type="button" class="btn" data-act="undo">Undo</button></div>
<p class="state">${esc(statusLabel(r.status, r))}</p>
${replyBlock(r, rep, env)}
${ctx.base ? writeupRow(r, wid, ctx.base) : ""}
</article>`;
}

// The results panel: reply rates by kind of business and by subject line, so outreach goes where it works.
const AUTO_KINDS = new Set(["automotive_repair", "auto_body_shop", "automotive_service", "auto_detailing", "tire_shop", "tire_dealer_and_repair", "auto_glass_service", "car_window_tinting"]);
const PARTNER_GROUP_LABEL = { lawyer: "Partners: lawyers", accounting: "Partners: accountants", insurance: "Partners: insurance", print: "Partners: print and signs" };
const CATEGORY_GROUP = { "dental-medical": "Health and dental", "medspa-salon": "Salons and spas", fitness: "Gyms and studios", "home-services": "Home services", restaurants: "Restaurants", retail: "Shops", "real-estate": "Real estate" };
export function resultGroup(r) {
  if (r.track === "partner") return PARTNER_GROUP_LABEL[(PARTNER_KINDS[r.kind] || {}).group] || "Partners: other";
  if (isLawFirm(r)) return "Law firms";
  if (AUTO_KINDS.has(r.kind)) return "Auto shops";
  return CATEGORY_GROUP[r.category] || "Other";
}

function tally(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    const t = m.get(k) || { key: k, sent: 0, replied: 0, interested: 0, bounced: 0 };
    t.sent++;
    if (r.replied) t.replied++;
    if (r.interested) t.interested++;
    if (r.bounced) t.bounced++;
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => b.sent - a.sent);
}

function resultsPanel(rows) {
  if (!rows.length) return "";
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
  const table = (caption, list, first) => `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(caption)}"><table><caption>${esc(caption)}</caption>
<thead><tr><th scope="col">${esc(first)}</th><th scope="col">Sent</th><th scope="col">Replies</th><th scope="col">Reply rate</th><th scope="col">Interested</th></tr></thead>
<tbody>${list.map((t) => `<tr><th scope="row">${esc(t.key)}</th><td>${t.sent}</td><td>${t.replied}</td><td>${pct(t.replied, t.sent)}</td><td>${t.interested}</td></tr>`).join("")}</tbody></table></div>`;
  const groups = tally(rows, resultGroup);
  const variants = tally(rows.filter((r) => r.variant), (r) => (r.variant === "B" ? "B: “Question about [business]’s website”" : "A: the drafted subject"));
  const total = rows.length, replied = rows.filter((r) => r.replied).length;
  return `<section class="panel" aria-labelledby="h-results"><h2 id="h-results">What's working</h2>
<p class="stats"><strong>${replied}</strong> ${replied === 1 ? "reply" : "replies"} from <strong>${total}</strong> ${total === 1 ? "email" : "emails"} (${pct(replied, total)}). "Interested" means their first reply said yes, asked a question or asked to talk.</p>
${table("By kind of business", groups, "Kind of business")}
${variants.length ? table("Subject line test (client emails)", variants, "Subject") : `<p class="muted">The subject line test starts with the next emails queued.</p>`}
<p class="muted">Small numbers swing a lot: wait for about 40 emails in a row before trusting a difference.</p></section>`;
}

function autoPanel(s) {
  if (!s.connected) {
    return `<section class="panel" aria-labelledby="h-auto"><h2 id="h-auto">Auto-send <span class="pill off">Not connected yet</span></h2>
<p class="muted">Everything is built: the queue, the follow-ups, the safety checks. One approval in your Google account connects your mailbox, and then emails go out on their own. Until then this board works the way it always has.</p></section>`;
  }
  const day = new Date(`${s.ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const bits = [
    `<strong>${s.sent}</strong> of ${s.cap} sent ${s.isToday ? "today" : `(${esc(day)})`}`,
    `<strong>${s.queued}</strong> queued${s.next ? `, next ${esc(whenLabel(s.next))}` : ""}`,
    `<strong>${s.followUps}</strong> ${s.followUps === 1 ? "follow-up" : "follow-ups"} waiting`,
  ];
  if (s.held) bits.push(`<strong>${s.held}</strong> held for you`);
  return `<section class="panel" aria-labelledby="h-auto"><h2 id="h-auto">Auto-send <span class="pill ${s.paused ? "off" : "on"}">${s.paused ? "Paused" : "On"}</span></h2>
<p class="stats">${bits.join(" · ")}</p>
${s.paused && s.reason ? `<p class="note">${esc(s.reason)}</p>` : ""}
<div class="row">${s.paused
    ? `<button type="button" class="btn primary" data-auto-act="resume">Resume auto-send</button>`
    : `<button type="button" class="btn" data-auto-act="pause">Pause auto-send</button><button type="button" class="btn" data-auto-act="fill">Top up the queue</button>`}</div>
<p class="muted">Weekdays 9:30 AM to 3:30 PM Eastern, from your mario@ mailbox. Today's limit is ${s.cap} (it rises slowly while the mailbox builds a sending history).</p></section>`;
}

async function boardPage(env, base, platform) {
  const [{ ready: readyAll, done, stats, writeups, replies, results }, sum] = await Promise.all([loadBoard(env), autoSummary(env)]);
  const ctx = { base, writeups, replies };
  const queued = readyAll.filter((r) => r.auto_state === "queued").sort((a, b) => String(a.send_at).localeCompare(String(b.send_at)));
  const ready = readyAll.filter((r) => r.auto_state !== "queued");
  const needYou = ready.filter((r) => r.auto_state === "held" || !r.contact_email);
  const prospects = ready.filter((r) => !needYou.includes(r));
  const partners = prospects.filter((r) => r.track === "partner");
  const repliedDone = done.filter((r) => r.replied_at || replies.has(r.id) || writeups.has(r.id));
  const outreachDone = done.filter((r) => !repliedDone.includes(r));
  const replyCount = [...replies.values()].filter((r) => ["new", "drafting", "drafted", "failed"].includes(r.state)).length;
  const size = num(env.DIGEST_SIZE, 5, 1, 10);
  const ops = esc(env.OPS_ADDRESS || "ops@mobiusintegration.com");
  const body = `<main class="wrap">
<header class="top">
<p class="eyebrow">Mobius Integration</p>
<h1>Prospect board</h1>
<p class="stats"><strong>${queued.length}</strong> sending automatically · <strong>${ready.length}</strong> need you · <strong>${stats.sent7 || 0}</strong> sent this week · <strong>${stats.replies || 0}</strong> ${stats.replies === 1 ? "reply" : "replies"} from ${plural(stats.sent_all || 0, "email", "emails")} · ${plural(stats.pool || 0, "more checked prospect", "more checked prospects")} and ${plural(stats.partners || 0, "partner", "partners")} in the queue</p>
<button type="button" class="btn primary" id="more" data-size="${size}">Get ${size} more</button>
${env.DISCORD_APP_ID && env.DISCORD_PUBLIC_KEY ? `<div class="row"><label for="discord-key">Discord bot key</label><input id="discord-key" type="password" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="discord-key-save">Save key</button></div><div class="row"><label for="discord-guild">Discord server ID</label><input id="discord-guild" inputmode="numeric" autocomplete="off"><button type="button" class="btn" id="discord-setup">Set up Discord</button></div>` : ""}
</header>
<nav class="tabs" role="tablist" aria-label="Board sections">
${[["today","Today",0], ["need-you","Need you",needYou.length], ["replies","Replies",replyCount], ["outreach","Outreach",0], ["prospects","Prospects",0], ["results","Results",0], ["how","How it works",0]].map(([id,label,count]) => `<button class="tab" id="tab-${id}" role="tab" aria-selected="false" aria-controls="panel-${id}" tabindex="-1" data-tab="${id}">${label}${count ? ` <span class="tab-count">${count}</span>` : ""}</button>`).join("")}
</nav>
<div class="tab-panel" id="panel-today" role="tabpanel" aria-labelledby="tab-today">${autoPanel(sum)}
${queued.length ? `<section aria-labelledby="h-queued"><h2 id="h-queued">Sending automatically</h2><p class="muted">These go out by themselves at the time shown, after a fresh look at their site. Tap Cancel this send to take one back.</p>${queued.map((r) => card(r, env, platform, ctx)).join("\n")}</section>` : `<p class="empty">Nothing is scheduled to send right now.</p>`}</div>
<div class="tab-panel" id="panel-need-you" role="tabpanel" aria-labelledby="tab-need-you"><section aria-labelledby="h-ready"><h2 id="h-ready">Need you</h2>${needYou.length ? needYou.map((r) => card(r, env, platform, ctx)).join("\n") : `<p class="empty">Nothing needs you right now. Tap Get ${size} more, or wait for tomorrow morning's email.</p>`}</section></div>
<div class="tab-panel" id="panel-replies" role="tabpanel" aria-labelledby="tab-replies">${repliedDone.length ? `<section aria-labelledby="h-replies"><h2 id="h-replies">Replies and write-ups</h2>${repliedDone.map((r) => card(r, env, platform, ctx)).join("\n")}</section>` : `<p class="empty">No recent replies or write-ups.</p>`}</div>
<div class="tab-panel" id="panel-outreach" role="tabpanel" aria-labelledby="tab-outreach">${autoPanel(sum)}<section aria-labelledby="h-outreach"><h2 id="h-outreach">Outreach and follow-ups</h2>${outreachDone.length ? outreachDone.map((r) => card(r, env, platform, ctx)).join("\n") : `<p class="empty">No completed outreach in the last 30 days.</p>`}</section></div>
<div class="tab-panel" id="panel-prospects" role="tabpanel" aria-labelledby="tab-prospects"><section aria-labelledby="h-prospects"><h2 id="h-prospects">Prospects and partners</h2>${prospects.length ? prospects.map((r) => card(r, env, platform, ctx)).join("\n") : `<p class="empty">No prospects are ready. Use Get ${size} more to look for checked businesses.</p>`}</section></div>
<div class="tab-panel" id="panel-results" role="tabpanel" aria-labelledby="tab-results">${resultsPanel(results) || `<p class="empty">Results will appear after emails are sent.</p>`}</div>
<div class="tab-panel" id="panel-how" role="tabpanel" aria-labelledby="tab-how"><footer class="how"><h2>How this works</h2><ul>
<li><strong>Auto-send</strong> emails every business that has an email address on its own website, a person's own address (jane@) ahead of a shared one (info@): first emails on weekday mornings from 9:30 AM Eastern (all before noon on the day before a holiday), up to two every 15 minutes, from your mario@ mailbox, a few a day at first. Before each one it looks at their site again, and if a finding is gone or the site doesn't load, it holds the email for you instead. A nudge follows on day 4 and a last note a week later, as replies in the same email thread. A reply, a bounce or a STOP ends everything for that business, and every email is in your Gmail Sent folder.</li>
<li><strong>When someone replies</strong>, a draft answer appears in that Gmail thread within about 15 minutes, and you get an email about it. If they want the write-up the first email offered, it's made in a real browser (screenshots, an example of each finding outlined in red) and attached as a PDF. Nothing is sent until you read the draft and tap Send. <strong>Make write-up (PDF)</strong> on any card makes one by hand, for a call or a walk-in.</li>
<li><strong>Need you</strong> holds the businesses auto-send can't email: no address on their site (use their contact form or call them), or an email it held back.</li>
<li><strong>Write in Gmail</strong> opens the drafted email in the Gmail app on your phone (Gmail on the web on a computer), addressed to them when their site lists an email. Read it, change anything you like, and send it from your Mobius account. A hidden copy goes to ${ops}, and this board marks it sent by itself.</li>
<li>Each draft already ends with your signature (name, title, phone, website) and the one-line notice the law requires in marketing emails. Gmail never adds its own signature to an email that opens already written, so nothing appears twice.</li>
<li>Using their contact form? Tap <strong>Copy message</strong> (it leaves out the email-only notice), paste it into the form, then tap <strong>Sent ✓</strong>.</li>
<li><strong>Referral partner</strong> cards ask accountants, insurance agents, print shops and business lawyers to send their clients your way. Lawyers are never paid for referrals (Bar rules); the client they send gets the first month free instead. Everyone else gets a flat thank-you once that client pays a second month.</li>
<li><strong>They replied</strong> keeps the reply count honest. <strong>Never contact</strong> puts them on the do-not-contact list; use it whenever someone asks you to stop.</li>
<li>Every tap can be undone.</li>
<li><strong>Keep it one tap away:</strong> bookmark this page or add it to your Home Screen. On this phone or computer it keeps opening the board, and so does <a href="${esc(homeUrl(env))}">${esc(homeText(env))}</a>. On any other device, that address emails you a fresh link.</li>
</ul></footer></div>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"><span id="toast-text"></span><button type="button" id="toast-undo" class="btn small" hidden>Undo</button></div>`;
  return shell({ title: `Prospect board (${needYou.length} need you)`, body, script: SCRIPT, base });
}

// ---------------------------------------------------------------------------
// The permanent address and fresh links

// A remembered device: send it to a fresh board link. A digest button's ?do=&id= rides along, so the
// board still applies it (undoably).
async function toFreshBoard(env, url) {
  const act = url.searchParams.get("do") || "", id = url.searchParams.get("id") || "";
  const q = ACTIONS.has(act) && /^\d{1,9}$/.test(id) ? `?do=${act}&id=${id}` : "";
  return new Response(null, {
    status: 302,
    headers: { Location: (await boardPath(env)) + q, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Strict-Transport-Security": HSTS },
  });
}

function linkPage(env, status, heading, lead) {
  const body = `<main class="wrap narrow">
<p class="eyebrow">Mobius Integration</p>
<h1>${esc(heading)}</h1>
<p>${esc(lead)}</p>
<p><button type="button" class="btn primary" id="send-link">Email me a fresh link</button></p>
<p id="link-msg" class="note" role="status" aria-live="polite"></p>
<p class="muted">The link goes only to the board owner's inbox. Open it once on this phone or computer, and ${esc(homeText(env))} opens the board here from then on.</p>
</main>`;
  return shell({ status, title: heading, body, script: LINK_SCRIPT });
}

const LINK_GAP_SECONDS = 10 * 60;
const LINK_DAILY_CAP = 5;

// Email a fresh board link. The recipient is always the founder (sendToFounder has no recipient
// parameter), so a stranger tapping the button can at most send the founder his own link, and the
// limits keep that to one email per 10 minutes and 5 a day.
export async function emailBoardLink(env, now = Date.now()) {
  const db = env.DB;
  const t = Math.floor(now / 1000);
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'link_sends'").first();
  let st = null;
  try { st = JSON.parse(row ? row.value : "null"); } catch {}
  const last = (st && Number(st.last)) || 0;
  const count = st && st.day === day ? Number(st.count) || 0 : 0;
  if (t - last < LINK_GAP_SECONDS) return { ok: true, sent: false, message: "A fresh link went to your inbox a few minutes ago. Check there (and spam) first." };
  if (count >= LINK_DAILY_CAP) return { ok: true, sent: false, message: `${LINK_DAILY_CAP} links went out today already. Use the newest one in your inbox.` };

  // Claim the send before sending, so two quick taps (or two devices) send one email, not two.
  const next = JSON.stringify({ day, count: count + 1, last: t });
  const claim = row
    ? await db.prepare("UPDATE meta SET value = ? WHERE key = 'link_sends' AND value = ?").bind(next, row.value).run()
    : await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('link_sends', ?)").bind(next).run();
  if (!claim.meta || !claim.meta.changes) return { ok: true, sent: false, message: "A fresh link is on its way. Check your inbox." };

  try {
    const board = await boardUrl(env);
    const home = homeUrl(env), shown = homeText(env);
    const text = [
      "Here's a fresh link to your prospect board:", board, "",
      `Open it on the phone or computer where you asked for it. After that, ${shown} opens the board there directly, so bookmark it or add it to your Home Screen.`, "",
      `Didn't ask for this? Someone tapped "Email me a fresh link" on ${shown}. Links only ever come to this inbox, so there's nothing to do.`,
    ].join("\n");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px">`
      + `<p style="margin:0 0 10px">Here's a fresh link to your prospect board.</p>`
      + `<p style="margin:0 0 12px">${button(board, "Open your prospect board", "primary")}</p>`
      + `<p style="margin:0 0 10px">Open it on the phone or computer where you asked for it. After that, <a href="${esc(home)}">${esc(shown)}</a> opens the board there directly, so bookmark it or add it to your Home Screen.</p>`
      + `<p style="margin:0;color:#4b5563;font-size:13px">Didn't ask for this? Someone tapped "Email me a fresh link" on ${esc(shown)}. Links only ever come to this inbox, so there's nothing to do.</p></div>`;
    await sendToFounder(env, "Your prospect board link", text, html);
  } catch (e) {
    console.error("prospector: board link email failed:", e && e.message);
    // Hand the claim back so the next tap can try again.
    try { await db.prepare("UPDATE meta SET value = ? WHERE key = 'link_sends' AND value = ?").bind(row ? row.value : "{}", next).run(); } catch {}
    return { ok: false, sent: false, error: "Couldn't send the email right now. Try again in a minute." };
  }
  return { ok: true, sent: true, message: "Sent. Open the email from Mobius prospects and tap the link on this phone or computer." };
}

// ---------------------------------------------------------------------------
// Responses

// The device cookie is Secure, so it never travels over plain http. Browsers that have opened the board
// over https remember to use https for this site from then on (no includeSubDomains, no preload list).
const HSTS = "max-age=31536000";

function notFound() {
  return shell({ status: 404, title: "Not found", body: `<main class="wrap"><h1>Not found</h1><p>This page doesn't exist.</p></main>` });
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" },
  });
}

function shell({ status = 200, title, body, script = "", base = "" }) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // email_off: the zone's email obfuscation would otherwise rewrite addresses into "[email protected]".
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><link rel="icon" href="/assets/img/logo.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="Prospects"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head><body${base ? ` data-base="${esc(base)}"` : ""}><!--email_off-->${body}<!--/email_off-->${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Strict-Transport-Security": HSTS,
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--ink:#1d2030;--muted:#555b6e;--line:#d5d8e2;--brand:#4338ca;--on-brand:#fff;--ok:#047857;--danger:#b42318;--chip:#eef0ff;--chip-ink:#3730a3;--focus:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#111219;--card:#1a1c26;--ink:#eceef6;--muted:#a6abbd;--line:#30344a;--brand:#9a9cff;--on-brand:#11121a;--ok:#4ade80;--danger:#ff8a80;--chip:#262a42;--chip-ink:#c7c9ff;--focus:#fbbf24}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:20px 16px 112px}
.tabs{display:flex;gap:4px;overflow-x:auto;position:sticky;top:0;z-index:5;margin:16px -16px 20px;padding:6px 16px;background:var(--bg);border-bottom:1px solid var(--line);scrollbar-width:thin;-webkit-overflow-scrolling:touch}
.tab{flex:none;min-height:44px;padding:8px 12px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);font-family:inherit;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;white-space:nowrap}
.tab[aria-selected="true"]{background:var(--card);border-color:var(--line);color:var(--ink)}
.tab-count{font-variant-numeric:tabular-nums;color:var(--brand)}
.tab-panel{padding-top:2px}
html.has-tabs .tab-panel[hidden]{display:none}
.wrap.narrow{max-width:560px}
.note{min-height:1.5em;font-weight:600}
.muted{color:var(--muted)}
.eyebrow{margin:0;color:var(--muted);font-size:13px;letter-spacing:.06em;text-transform:uppercase}
h1{font-size:28px;line-height:1.2;margin:2px 0 6px}
h2{font-size:18px;margin:30px 0 12px}
.stats{margin:0 0 14px;color:var(--muted)}
.stats strong{color:var(--ink)}
a{color:var(--brand)}
.card{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--brand);border-radius:12px;padding:14px 16px;margin:0 0 14px}
.card[data-status="sent"]{border-left-color:var(--ok)}
.card[data-status="skipped"]{border-left-color:var(--muted)}
.card[data-status="suppressed"]{border-left-color:var(--danger)}
.card-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}
.card h3{font-size:18px;line-height:1.3;margin:0;overflow-wrap:anywhere}
.chip{flex:none;background:var(--chip);color:var(--chip-ink);border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600}
.meta{margin:4px 0 0;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.chip.partner{background:var(--brand);color:var(--on-brand)}
.pnote{margin:10px 0 0;color:var(--muted)}
.findings{margin:10px 0 0;padding-left:20px}
.findings li{margin:2px 0}
.contact{margin:10px 0 0;overflow-wrap:anywhere}
.draft{margin:12px 0 0;border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.draft summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}
.draft pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:15px;margin:10px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--on-brand)}
.btn.danger{color:var(--danger)}
.btn.small{min-height:36px;padding:4px 12px;font-size:14px}
.btn:disabled{opacity:.6;cursor:progress}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 14px}
.panel h2{margin:0 0 8px}
.panel .stats{margin:0 0 4px;color:var(--ink)}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:13px;font-weight:700;vertical-align:middle;margin-left:6px;border:1px solid}
.pill.on{color:var(--ok);border-color:var(--ok)}
.pill.off{color:var(--danger);border-color:var(--danger)}
.when-auto{display:none}
.card[data-auto="queued"] .when-ready{display:none}
.card[data-auto="queued"] .when-auto{display:flex}
.card[data-auto] .state{display:block}
.card[data-auto="queued"]{border-left-color:var(--focus)}
.card[data-nofollow="1"] [data-act="nofollow"],.card[data-nofollow="0"] [data-act="follow"],.card[data-replied="1"] [data-act="nofollow"],.card[data-replied="1"] [data-act="follow"]{display:none}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.when-sent,.when-closed{display:none}
.card:not([data-status="digested"]) .when-ready{display:none}
.card[data-status="sent"] .when-sent{display:flex}
.card[data-status="skipped"] .when-closed,.card[data-status="suppressed"] .when-closed{display:flex}
.card[data-replied="1"] [data-act="replied"],.card[data-replied="0"] [data-act="unreplied"]{display:none}
.card:not([data-status="digested"]) .findings{display:none}
.state{margin:12px 0 0;font-weight:700}
.card[data-status="digested"] .state{display:none}
.card[data-status="sent"] .state{color:var(--ok)}
.card[data-status="suppressed"] .state{color:var(--danger)}
.empty{color:var(--muted)}
.reply{margin:12px 0 0;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--bg)}
.reply p{margin:0 0 6px;overflow-wrap:anywhere}
.reply .row{margin-top:6px}
.card[data-status="skipped"] .wrow,.card[data-status="suppressed"] .wrow{display:none}
.tablewrap{overflow-x:auto;margin:10px 0}
.tablewrap table{border-collapse:collapse;width:100%;min-width:30rem;font-size:14px;font-variant-numeric:tabular-nums}
.tablewrap caption{text-align:left;font-weight:700;margin-bottom:4px}
.tablewrap th,.tablewrap td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right}
.tablewrap th[scope=row],.tablewrap thead th:first-child{text-align:left}
.tablewrap thead th{color:var(--muted);font-weight:600}
.how{margin-top:40px;color:var(--muted)}
.how h2{color:var(--ink)}
.how li{margin:6px 0}
.toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(560px,calc(100% - 32px));background:var(--ink);color:var(--bg);border-radius:12px;padding:12px 14px;display:flex;gap:12px;align-items:center;justify-content:space-between;box-shadow:0 8px 24px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .15s}
.toast.show{opacity:1;pointer-events:auto}
.toast .btn{background:transparent;color:var(--bg);border-color:var(--bg)}
.flash{animation:flash 1.8s ease-out}
@keyframes flash{from{box-shadow:0 0 0 4px var(--focus)}to{box-shadow:0 0 0 0 transparent}}
@media (prefers-reduced-motion:reduce){.flash{animation:none}.toast{transition:none}}
`;

// The "Email me a fresh link" page's only script. No template literals inside.
const LINK_SCRIPT = `
(function () {
  var b = document.getElementById("send-link");
  var msg = document.getElementById("link-msg");
  b.addEventListener("click", function () {
    b.disabled = true;
    msg.textContent = "Sending...";
    fetch("/ops/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (res) { return res.json(); })
      .then(function (d) {
        msg.textContent = d.message || d.error || "Done.";
        if (d.sent) b.textContent = "Sent \\u2713";
        else if (!d.ok) b.disabled = false;
      }, function () {
        msg.textContent = "That didn't work. Check your connection and try again.";
        b.disabled = false;
      });
  });
})();
`;

// The board's only script. No template literals inside, so it stays a plain string.
const SCRIPT = `
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  var panels = tabs.map(function (tab) { return document.getElementById(tab.getAttribute("aria-controls")); });
  function selectTab(id, updateHash, focusTab) {
    var i = tabs.findIndex(function (tab) { return tab.getAttribute("data-tab") === id; });
    if (i < 0) i = 0;
    tabs.forEach(function (tab, n) {
      var active = n === i;
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
      panels[n].hidden = !active;
    });
    if (updateHash && location.hash !== "#" + tabs[i].getAttribute("data-tab")) history.replaceState(null, "", location.pathname + location.search + "#" + tabs[i].getAttribute("data-tab"));
    if (focusTab) tabs[i].focus();
    tabs[i].scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  document.documentElement.classList.add("has-tabs");
  var initial = location.hash.slice(1);
  if (!tabs.some(function (tab) { return tab.getAttribute("data-tab") === initial; })) {
    initial = document.querySelector('#panel-need-you article, #panel-replies article') ? "need-you" : "today";
    if (document.querySelector('#panel-need-you article') === null && document.querySelector('#panel-replies article')) initial = "replies";
  }
  selectTab(initial, !location.hash, false);
  window.addEventListener("hashchange", function () { selectTab(location.hash.slice(1), false, false); });
  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { selectTab(tab.getAttribute("data-tab"), true, false); });
    tab.addEventListener("keydown", function (e) {
      var next = index;
      if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else return;
      e.preventDefault(); selectTab(tabs[next].getAttribute("data-tab"), true, true);
    });
  });
  var base = document.body.getAttribute("data-base");
  var toast = document.getElementById("toast");
  var toastText = document.getElementById("toast-text");
  var toastUndo = document.getElementById("toast-undo");
  var undoFn = null, timer = 0;
  var discordKeySave = document.getElementById("discord-key-save");
  if (discordKeySave) discordKeySave.addEventListener("click", function () {
    var input = document.getElementById("discord-key"); discordKeySave.disabled = true;
    post("/discord", { key: input.value }).then(function (d) { input.value = ""; say(d.ok ? "Bot key saved, and Discord accepted it." : (d.error || "Could not save the key.")); discordKeySave.disabled = false; });
  });
  var discordSetup = document.getElementById("discord-setup");
  if (discordSetup) discordSetup.addEventListener("click", function () {
    var input = document.getElementById("discord-guild"); discordSetup.disabled = true;
    post("/discord", { guild_id: input.value }).then(function (d) { say(d.ok ? "Discord office is ready." : (d.error || "Discord setup failed.")); discordSetup.disabled = false; });
  });
  var INVERSE = { sent: "undo", skip: "undo", never: "undo", replied: "unreplied", unreplied: "replied", nofollow: "follow", follow: "nofollow" };
  function say(text, undo) {
    toastText.textContent = text;
    undoFn = undo || null;
    toastUndo.hidden = !undo;
    toast.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(function () { toast.classList.remove("show"); toastUndo.hidden = true; undoFn = null; }, undo ? 10000 : 5000);
  }
  toastUndo.addEventListener("click", function () { var f = undoFn; undoFn = null; if (f) f(); });
  function post(path, data) {
    return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { d.httpOk = res.ok; return d; }); });
  }
  function act(id, action, via) {
    var card = document.getElementById("p" + id);
    var buttons = card ? card.querySelectorAll("button") : [];
    buttons.forEach(function (b) { b.disabled = true; });
    return post("/mark", { id: id, action: action, via: via }).then(function (d) {
      if (!d.httpOk || !d.ok) { say(d.error || "That didn't save. Check your connection and try again."); return; }
      if (card) {
        card.setAttribute("data-status", d.status);
        card.setAttribute("data-replied", d.replied ? "1" : "0");
        card.setAttribute("data-nofollow", d.nofollow ? "1" : "0");
        if (d.status === "digested" && (d.auto === "queued" || d.auto === "held")) card.setAttribute("data-auto", d.auto);
        else card.removeAttribute("data-auto");
        card.querySelector(".state").textContent = d.label;
      }
      var inverse = INVERSE[action];
      say(d.name + ": " + d.label, inverse ? function () { act(id, inverse, "board"); } : null);
      // A cancelled automatic send moves down to Need you, where Write in Gmail is waiting.
      if (action === "cancel") setTimeout(function () { location.reload(); }, 1200);
    }, function () {
      say("That didn't save. Check your connection and try again.");
    }).then(function () {
      buttons.forEach(function (b) { b.disabled = false; });
    });
  }
  function autoAct(b) {
    var action = b.getAttribute("data-auto-act");
    var label = b.textContent;
    b.disabled = true;
    if (action === "fill") b.textContent = "Working, up to a minute...";
    post("/auto", { action: action }).then(function (d) {
      if (d.httpOk && d.ok && !(action === "fill" && !d.queued)) { location.reload(); return; }
      say(d.message || d.error || "That didn't work. Try again in a minute.");
      b.disabled = false; b.textContent = label;
    }, function () {
      say("That didn't work. Check your connection and try again.");
      b.disabled = false; b.textContent = label;
    });
  }
  function makeWriteup(b) {
    var c = b.closest("[data-id]");
    if (!c) return;
    var label = b.textContent;
    b.disabled = true;
    b.textContent = "Making it, about a minute...";
    post("/writeup", { id: Number(c.getAttribute("data-id")) }).then(function (d) {
      if (d.httpOk && d.ok && d.url) {
        var row = b.closest(".wrow");
        var a = row ? row.querySelector("a.btn") : null;
        if (row && !a) {
          a = document.createElement("a");
          a.className = "btn";
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          row.insertBefore(a, b);
        }
        if (a) { a.href = d.url; a.textContent = "Open write-up (PDF)"; }
        b.textContent = "Make a fresh one";
        b.classList.add("small");
        b.disabled = false;
        say("Write-up ready. Tap Open write-up (PDF).");
        return;
      }
      say(d.error || "That didn't work. Try again in a minute.");
      b.disabled = false; b.textContent = label;
    }, function () {
      say("That didn't work. Check your connection and try again.");
      b.disabled = false; b.textContent = label;
    });
  }
  document.addEventListener("click", function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    var ab = t.closest("[data-auto-act]");
    if (ab) { autoAct(ab); return; }
    var wb = t.closest("[data-writeup]");
    if (wb) { makeWriteup(wb); return; }
    var b = t.closest("[data-act]");
    if (b) {
      var c = b.closest("[data-id]");
      if (c) act(Number(c.getAttribute("data-id")), b.getAttribute("data-act"), "board");
      return;
    }
    var copy = t.closest("[data-copy]");
    if (copy) {
      var text = copy.getAttribute("data-copy") || copy.closest(".draft").querySelector("pre").textContent;
      navigator.clipboard.writeText(text).then(function () {
        say("Message copied. Paste it into their contact form, then tap Sent.");
      }, function () {
        say("Couldn't copy. Select the text and copy it instead.");
      });
    }
  });
  var more = document.getElementById("more");
  if (more) more.addEventListener("click", function () {
    var label = more.textContent;
    more.disabled = true;
    more.textContent = "Finding and drafting, about 30 seconds...";
    post("/more", {}).then(function (d) {
      if (d.httpOk && d.ok && d.added) { location.reload(); return; }
      say(d.error || (d.ok ? "Nothing new to add right now: today's automatic queue is full, or every business with an email already has its turn." : "That didn't work. Try again in a minute."));
      more.disabled = false; more.textContent = label;
    }, function () {
      say("That didn't work. Try again in a minute.");
      more.disabled = false; more.textContent = label;
    });
  });
  // A button in the digest email lands here as ?do=sent&id=123: apply it where it can be undone.
  var q = new URLSearchParams(location.search);
  var doAct = q.get("do"), doId = Number(q.get("id"));
  if (doAct && doId > 0) {
    history.replaceState(null, "", location.pathname + location.hash);
    var target = document.getElementById("p" + doId);
    if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("flash"); }
    act(doId, doAct, "email-button");
  }
})();
`;
