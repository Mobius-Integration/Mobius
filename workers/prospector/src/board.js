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

import { checkBoard, checkDevice, deviceCookie, boardPath, boardUrl, homeUrl, homeText } from "./tokens.js";
import { markProspect, statusLabel, ACTIONS } from "./marks.js";
import { esc, button, formText, CATEGORY_LABELS, findingsFor, prepareItems, recordDigest } from "./digest.js";
import { composeLinks, platformOf, writeLink } from "./compose.js";
import { hostOf } from "./contacts.js";
import { sendToFounder } from "./mail.js";

const ROUTE = /^\/ops\/b\/(\d{9,11})\/([A-Za-z0-9_-]{43})(?:\/(mark|more))?\/?$/;
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

  if (!sub) {
    if (!isGet(request)) return json(405, { ok: false, error: "Use GET." });
    const page = await boardPage(env, base, platformOf(request.headers.get("user-agent")));
    page.headers.append("Set-Cookie", await deviceCookie(env));
    return page;
  }
  if (request.method !== "POST") return json(405, { ok: false, error: "Use POST." });
  if (!isJson(request)) return json(415, { ok: false, error: "Send JSON." });

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

  // sub === "more"
  try {
    const items = await prepareItems(env, num(env.DIGEST_SIZE, 5, 1, 10));
    if (items.length) await recordDigest(env.DB, items, "board");
    return json(200, { ok: true, added: items.length });
  } catch (e) {
    console.error("prospector: board more failed:", e && e.message);
    return json(500, { ok: false, error: "Couldn't draft more right now. Try again in a minute." });
  }
}

// ---------------------------------------------------------------------------
// Data

const COLUMNS = `p.id, p.domain, p.website, p.name, p.category, p.city, p.phone, p.score, p.status, p.updated_at,
       o.digest_date, o.draft_subject, o.draft_body, o.contact_email, o.contact_url, o.contact_form, o.sent_at, o.sent_via, o.replied_at,
       c.issues_json, c.final_url
  FROM prospects p
  JOIN outreach o ON o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = p.id)
  LEFT JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id)`;

async function loadBoard(env) {
  const db = env.DB;
  const [ready, done, stats] = await db.batch([
    db.prepare(`SELECT ${COLUMNS} WHERE p.status = 'digested' ORDER BY p.score DESC, p.id LIMIT 60`),
    db.prepare(`SELECT ${COLUMNS} WHERE p.status IN ('sent','skipped','suppressed') AND p.updated_at >= datetime('now','-30 days') ORDER BY p.updated_at DESC LIMIT 60`),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM outreach WHERE founder_status = 'sent' AND COALESCE(sent_at, updated_at) >= datetime('now','-7 days')) AS sent7,
         (SELECT COUNT(*) FROM outreach WHERE founder_status = 'sent') AS sent_all,
         (SELECT COUNT(*) FROM outreach WHERE replied_at IS NOT NULL) AS replies,
         (SELECT COUNT(*) FROM prospects WHERE status = 'checked' AND sightings < 3 AND score >= ? AND domain NOT IN (SELECT value FROM suppression)) AS pool`,
    ).bind(num(env.MIN_SCORE, 30, 0, 100)),
  ]);
  return { ready: ready.results || [], done: done.results || [], stats: (stats.results && stats.results[0]) || {} };
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

function card(r, env, platform) {
  const site = r.final_url || r.website;
  const issues = findingsFor(r).slice(0, 4);
  const links = composeLinks(env, { to: r.contact_email, subject: r.draft_subject, body: r.draft_body });
  const write = writeLink(links, platform);
  const tel = r.phone ? String(r.phone).replace(/[^\d+]/g, "") : "";
  return `<article class="card" id="p${r.id}" data-id="${r.id}" data-status="${esc(r.status)}" data-replied="${r.replied_at ? 1 : 0}">
<div class="card-head"><h3>${esc(r.name)}</h3><span class="chip">Score ${esc(r.score)}</span></div>
<p class="meta">${esc(CATEGORY_LABELS[r.category] || r.category)}${r.city ? ` · ${esc(r.city)}` : ""}${tel ? ` · <a href="tel:${esc(tel)}">${esc(r.phone)}</a>` : ""}</p>
<p class="meta"><a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(site) || r.domain)}</a></p>
${issues.length ? `<ul class="findings">${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
<p class="contact">${contactLine(r)}</p>
<details class="draft"><summary>Draft: ${esc(r.draft_subject)}</summary><pre>${esc(r.draft_body)}</pre><button type="button" class="btn small" data-copy="${esc(formText(r.draft_body))}">Copy message</button></details>
<div class="row when-ready"><a class="btn primary" href="${esc(write.href)}"${write.newTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>Write in Gmail</a><a class="btn" href="${esc(links.mailto)}">Other mail app</a></div>
<div class="row when-ready"><button type="button" class="btn" data-act="sent">Sent ✓</button><button type="button" class="btn" data-act="skip">Skip</button><button type="button" class="btn danger" data-act="never">Never contact</button></div>
<div class="row when-sent"><button type="button" class="btn" data-act="replied">They replied</button><button type="button" class="btn" data-act="unreplied">Not a reply</button><button type="button" class="btn danger" data-act="never">Never contact</button><button type="button" class="btn" data-act="undo">Undo</button></div>
<div class="row when-closed"><button type="button" class="btn" data-act="undo">Undo</button></div>
<p class="state">${esc(statusLabel(r.status, r))}</p>
</article>`;
}

async function boardPage(env, base, platform) {
  const { ready, done, stats } = await loadBoard(env);
  const size = num(env.DIGEST_SIZE, 5, 1, 10);
  const ops = esc(env.OPS_ADDRESS || "ops@mobiusintegration.com");
  const body = `<main class="wrap">
<header class="top">
<p class="eyebrow">Mobius Integration</p>
<h1>Prospect board</h1>
<p class="stats"><strong>${ready.length}</strong> ready · <strong>${stats.sent7 || 0}</strong> sent this week · <strong>${stats.replies || 0}</strong> ${stats.replies === 1 ? "reply" : "replies"} from ${plural(stats.sent_all || 0, "email", "emails")} · ${plural(stats.pool || 0, "more checked prospect", "more checked prospects")} in the queue</p>
<button type="button" class="btn primary" id="more" data-size="${size}">Get ${size} more</button>
</header>
<section aria-labelledby="h-ready"><h2 id="h-ready">Ready to send</h2>
${ready.length ? ready.map((r) => card(r, env, platform)).join("\n") : `<p class="empty">Nothing waiting. Tap Get ${size} more, or wait for tomorrow morning's email.</p>`}
</section>
${done.length ? `<section aria-labelledby="h-done"><h2 id="h-done">Done in the last 30 days</h2>\n${done.map((r) => card(r, env, platform)).join("\n")}\n</section>` : ""}
<footer class="how"><h2>How this works</h2><ul>
<li><strong>Write in Gmail</strong> opens the drafted email in the Gmail app on your phone (Gmail on the web on a computer), addressed to them when their site lists an email. Read it, change anything you like, and send it from your Mobius account. A hidden copy goes to ${ops}, and this board marks it sent by itself.</li>
<li><strong>Your signature:</strong> Gmail adds your Mobius signature (name, phone, website) under the draft; check it's there the first time you write from your phone. On a computer, Gmail leaves it off emails that open already written, so click the pen icon (Insert signature) in the bottom toolbar before sending.</li>
<li>Using their contact form? Tap <strong>Copy message</strong> (it ends with your name, phone and website instead of the email-only lines), paste it into the form, then tap <strong>Sent ✓</strong>.</li>
<li><strong>They replied</strong> keeps the reply count honest. <strong>Never contact</strong> puts them on the do-not-contact list; use it whenever someone asks you to stop.</li>
<li>Every tap can be undone.</li>
<li><strong>Keep it one tap away:</strong> bookmark this page or add it to your Home Screen. On this phone or computer it keeps opening the board, and so does <a href="${esc(homeUrl(env))}">${esc(homeText(env))}</a>. On any other device, that address emails you a fresh link.</li>
</ul></footer>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"><span id="toast-text"></span><button type="button" id="toast-undo" class="btn small" hidden>Undo</button></div>`;
  return shell({ title: `Prospect board (${ready.length} ready)`, body, script: SCRIPT, base });
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
  var base = document.body.getAttribute("data-base");
  var toast = document.getElementById("toast");
  var toastText = document.getElementById("toast-text");
  var toastUndo = document.getElementById("toast-undo");
  var undoFn = null, timer = 0;
  var INVERSE = { sent: "undo", skip: "undo", never: "undo", replied: "unreplied", unreplied: "replied" };
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
        card.querySelector(".state").textContent = d.label;
      }
      var inverse = INVERSE[action];
      say(d.name + ": " + d.label, inverse ? function () { act(id, inverse, "board"); } : null);
    }, function () {
      say("That didn't save. Check your connection and try again.");
    }).then(function () {
      buttons.forEach(function (b) { b.disabled = false; });
    });
  }
  document.addEventListener("click", function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
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
      say(d.error || (d.ok ? "No more checked prospects are waiting. The next map harvest adds more." : "That didn't work. Try again in a minute."));
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
    history.replaceState(null, "", location.pathname);
    var target = document.getElementById("p" + doId);
    if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("flash"); }
    act(doId, doAct, "email-button");
  }
})();
`;
