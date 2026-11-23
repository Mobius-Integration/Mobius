// Contact route lookup: the contact page link and an email address the business publishes on its own
// website, so the founder (or the auto-sender) can write to them without hunting. Read-only GETs, like a
// visitor clicking around: the home page, then up to four likely pages on the same site (contact, team or
// attorneys, about, locations), skipping anything the site's robots.txt disallows. It reads mailto: links,
// addresses written out as text, and the email in a page's structured data (JSON-LD and microdata).
//
// It never guesses an address, and never decodes an address a site hides from bots (Cloudflare's email
// protection, HTML-entity tricks): that is the owner saying "not for scrapers", so those sites get the
// contact page link, and `hidden` is set so the board can say why there's no email.

import { readCappedBytes } from "../../shared/site-check.js";

const MAX_BYTES = 150 * 1024;
// The prospector's honest identity, for the checks and the contact lookup alike.
export const PROSPECTOR_UA = "Mozilla/5.0 (compatible; MobiusProspector/1.0; +https://mobiusintegration.com)";

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "bellsouth.net",
  "tampabay.rr.com", "rr.com", "spectrum.net", "frontier.com", "frontiernet.net", "earthlink.net", "protonmail.com", "proton.me",
]);
// Mailboxes a business answers. Preferred over a person's address when a site lists both.
const ROLE = /^(info|contact|hello|hi|office|admin|team|sales|bookings?|reservations?|orders?|events?|catering|manager|owner|appointments?|frontdesk|reception|service|inquir(y|ies)|enquir(y|ies)|mail)$/;
const NEVER_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|abuse|privacy|dmca|unsubscribe|bounces?|webmaster|hostmaster|security|legal|careers|jobs|hr|resumes?)$/;
const PLACEHOLDER_LOCAL = /^(you|your(name|email)?|name|firstname|first\.?last|email|user(name)?|example|test|someone|john\.?doe|jane\.?doe|me)$/;
const JUNK_DOMAIN = /(^|\.)(example\.(com|org|net)|domain\.(com|tld)|email\.com|test\.com|sentry\.io|wixpress\.com|wix\.com|squarespace\.com|godaddy\.com|wordpress\.(com|org)|mysite\.com|yoursite\.com|yourdomain\.com|company\.com|sitename\.com|website\.com|address\.com)$/;
const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|bmp|tiff?|mp4|webm|woff2?)$/i;
// "Website by jane@studio.com": the web designer's address, not the business's.
const DESIGNER = /\b(design(ed)?|develop(ed|ment)|website|site|web|powered|hosted|built|created|made|marketing|managed)\s+(by|with)\b[^@]{0,80}$/i;
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;

export const hostOf = (u) => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
};
// The last two labels. Good enough for the .com/.net/.org/.us sites in this list (not for .co.uk).
export const rootOf = (h) => h.split(".").slice(-2).join(".");

// How closely an address belongs to a site: 30 on the site's own domain, 20 on a common free-mail
// provider (many small businesses use one), 10 on a domain that is clearly a variant of the site's, else -1.
// The auto-sender only uses 20 and up.
export function emailBase(email, siteUrl) {
  const site = hostOf(siteUrl);
  const e = String(email || "").trim().toLowerCase();
  if (!site || !EMAIL_RE.test(e)) return -1;
  const dom = e.split("@")[1];
  const siteRoot = rootOf(site);
  if (dom === siteRoot || dom.endsWith("." + siteRoot)) return 30;
  if (FREE_MAIL.has(dom)) return 20;
  const siteLabel = siteRoot.split(".")[0];
  const label = rootOf(dom).split(".")[0];
  return label.length >= 4 && siteLabel.length >= 4 && (siteLabel.includes(label) || label.includes(siteLabel)) ? 10 : -1;
}

// True when the page hides an address from bots (Cloudflare's email protection).
export const hasObfuscatedEmail = (html) => /data-cfemail|\/cdn-cgi\/l\/email-protection/i.test(html);

// Every address on the page: mailto: links, addresses written out as text, and the email in JSON-LD or
// microdata. Scripts, styles and tags are blanked with spaces of the same length, so a match's position
// still lines up with the HTML.
export function emailCandidates(html) {
  const text = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, (s) => " ".repeat(s.length))
    .replace(/<[^>]*>/g, (s) => " ".repeat(s.length));
  const list = [];
  for (const m of html.matchAll(/href\s*=\s*["']?\s*mailto:([^"'?#\s>]+)/gi)) {
    let v = m[1];
    try { v = decodeURIComponent(v); } catch { /* keep as written */ }
    list.push({ value: v, at: m.index, mailto: true });
  }
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g)) {
    list.push({ value: m[0], at: m.index, mailto: false });
  }
  // Structured data: the business's own statement of its email.
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const stack = [data];
    for (let guard = 0; stack.length && guard < 500; guard++) {
      const v = stack.pop();
      if (Array.isArray(v)) stack.push(...v);
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (k === "email" && typeof val === "string") list.push({ value: val.replace(/^mailto:/i, ""), at: m.index, mailto: true });
          else if (val && typeof val === "object") stack.push(val);
        }
      }
    }
  }
  for (const m of html.matchAll(/itemprop\s*=\s*["']email["'][^>]*?(?:content\s*=\s*["']([^"']+)["']|>\s*([^<\s][^<]*?)\s*<)/gi)) {
    const v = String(m[1] || m[2] || "").trim().replace(/^mailto:/i, "");
    if (v) list.push({ value: v, at: m.index, mailto: true });
  }
  return { list, text };
}

// The best address for the business at siteUrl as { email, rank }, or null.
export function bestEmailRanked(html, siteUrl) {
  const { list, text } = emailCandidates(html);
  const ranks = new Map();
  for (const c of list) {
    const e = String(c.value).trim().toLowerCase().replace(/^mailto:/, "").replace(/[.,;:]+$/, "");
    if (e.length > 254 || !EMAIL_RE.test(e) || ASSET.test(e)) continue;
    const [local, dom] = e.split("@");
    if (NEVER_LOCAL.test(local) || PLACEHOLDER_LOCAL.test(local) || JUNK_DOMAIN.test(dom)) continue;
    if (DESIGNER.test(text.slice(Math.max(0, c.at - 160), c.at).replace(/\s+/g, " "))) continue;
    let rank = emailBase(e, siteUrl);
    if (rank < 0) continue;
    if (ROLE.test(local)) rank += 3;
    if (c.mailto) rank += 1;
    if (!(ranks.get(e) >= rank)) ranks.set(e, rank);
  }
  let best = null;
  let top = -1;
  for (const [e, r] of ranks) if (r > top) { best = e; top = r; }
  return best ? { email: best, rank: top } : null;
}

export function bestEmail(html, siteUrl) {
  const b = bestEmailRanked(html, siteUrl);
  return b ? b.email : null;
}

const hrefOf = (attrs) => ((/\shref\s*=\s*["']([^"']+)["']/i.exec(" " + attrs) || /\shref\s*=\s*([^\s>"']+)/i.exec(" " + attrs)) || [])[1];
const labelOf = (inner) => inner.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
const NOT_A_PAGE = /\.(pdf|docx?|xlsx?|png|jpe?g|gif|svg|webp|zip|mp4)(\?|$)/i;

// The site's own contact page, or null: a link whose text says "contact" (or "get in touch") or whose
// path has /contact, on the same host. A link with both wins.
export function contactPageLink(html, pageUrl) {
  const site = hostOf(pageUrl);
  if (!site) return null;
  let fallback = null;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = hrefOf(m[1]);
    if (!href || /^\s*(#|mailto:|tel:|sms:|javascript:)/i.test(href)) continue;
    const byText = /\b(contact(\s+us)?|get in touch|reach us)\b/i.test(labelOf(m[2]));
    const byPath = /\/contact/i.test(href);
    if (!byText && !byPath) continue;
    let u;
    try { u = new URL(href.trim(), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.toString()) !== site || NOT_A_PAGE.test(u.pathname)) continue;
    u.hash = "";
    if (byText && byPath) return u.toString();
    if (!fallback) fallback = u.toString();
  }
  return fallback;
}

// Other pages on the same site where a business lists an email: a team or attorneys page, the about page,
// a locations page. Best first, at most `limit`.
const PAGE_HINTS = [
  [/contact|get in touch/i, 0],
  [/attorneys?|lawyers?|our[- ]team|\bteam\b|\bstaff\b|\bpeople\b|meet |doctors?|providers?|professionals?/i, 1],
  [/\babout\b/i, 2],
  [/locations?|\boffices?\b|visit us|find us|\bhours\b/i, 3],
];
export function candidateLinks(html, pageUrl, limit = 3) {
  const site = hostOf(pageUrl);
  if (!site) return [];
  const found = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = hrefOf(m[1]);
    if (!href || /^\s*(#|mailto:|tel:|sms:|javascript:)/i.test(href)) continue;
    let u;
    try { u = new URL(href.trim(), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.toString()) !== site || NOT_A_PAGE.test(u.pathname) || u.pathname === "/") continue;
    u.hash = "";
    const hay = `${labelOf(m[2])} ${u.pathname}`;
    const hint = PAGE_HINTS.find(([re]) => re.test(hay));
    if (!hint) continue;
    const key = u.toString();
    if (!(found.get(key) <= hint[1])) found.set(key, hint[1]);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).slice(0, limit).map((e) => e[0]);
}

export const hasContactForm = (html) => /<form\b[\s\S]*?(type\s*=\s*["']?email|<textarea\b)/i.test(html);

// robots.txt: may our crawler fetch this path? The group for our own name wins over "*"; the longest
// matching rule wins; Allow beats Disallow on a tie. No file or no rules: allowed.
export function robotsAllows(robotsText, path, agent = "mobiusprospector") {
  const groups = [];
  let cur = null;
  for (const raw of String(robotsText || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const f = m[1].toLowerCase();
    const v = m[2].trim();
    if (f === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
    } else if (cur && (f === "allow" || f === "disallow")) cur.rules.push([f, v]);
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const use = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of use) {
    for (const [f, v] of g.rules) {
      if (!v) continue;
      const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      if (re.test(path) && (!best || v.length > best.len || (v.length === best.len && f === "allow"))) best = { len: v.length, allow: f === "allow" };
    }
  }
  return best ? best.allow : true;
}

async function getText(url, userAgent, timeoutMs, maxBytes) {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": userAgent, Accept: "text/plain" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { try { await res.body.cancel(); } catch { /* no body */ } return ""; }
    return new TextDecoder().decode(await readCappedBytes(res, maxBytes));
  } catch {
    return "";
  }
}

async function getPage(url, userAgent, timeoutMs) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": userAgent, Accept: "text/html" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) {
      try { await res.body.cancel(); } catch { /* no body */ }
      return null;
    }
    const html = new TextDecoder().decode(await readCappedBytes(res, MAX_BYTES));
    return { url: res.url || url, html };
  } catch {
    return null;
  }
}

// Can this address's domain receive mail? A DNS lookup (MX, else an address record) over Cloudflare's
// resolver. A bounce hurts the sender's reputation, so the auto-sender skips domains that can't. If the
// lookup itself fails we can't tell, so the address passes.
const mxCache = new Map();
export async function mxOk(domain, { fetchImpl = fetch } = {}) {
  const d = String(domain || "").toLowerCase();
  if (!d) return false;
  if (mxCache.has(d)) return mxCache.get(d);
  let ok = true;
  const ask = async (type) => {
    const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`DNS ${res.status}`);
    return res.json();
  };
  try {
    const mx = await ask("MX");
    if (mx.Status === 3) ok = false; // the domain doesn't exist
    else {
      const records = (mx.Answer || []).filter((a) => a.type === 15);
      if (records.length) ok = records.some((a) => String(a.data).trim().split(/\s+/)[1] !== "."); // "0 ." is a null MX: no mail
      else {
        const a = await ask("A");
        ok = (a.Answer || []).some((r) => r.type === 1);
      }
    }
  } catch {
    ok = true;
  }
  mxCache.set(d, ok);
  return ok;
}

// { email, rank, url, form, hidden, pages, error }. `url` is the contact page link (null if none); `form`
// is true when that page has a contact form; `hidden` is true when a page hides an address from bots.
// Never throws.
export async function findContact(p, { userAgent, timeoutMs = 8000, maxPages = 4 } = {}) {
  const start = p.final_url || p.website;
  const home = await getPage(start, userAgent, timeoutMs);
  if (!home) return { email: null, rank: -1, url: null, form: false, hidden: false, pages: 0, error: "The page didn't load for the contact lookup." };
  const origin = new URL(home.url).origin;
  let best = bestEmailRanked(home.html, home.url);
  let hidden = hasObfuscatedEmail(home.html);
  let url = contactPageLink(home.html, home.url);
  let form = false;

  const queue = [];
  if (url && url !== home.url) queue.push(url);
  for (const u of candidateLinks(home.html, home.url)) if (u !== home.url && !queue.includes(u)) queue.push(u);
  // No contact link on the home page: try the usual paths, since many sites have one anyway.
  if (!url) for (const path of ["/contact", "/contact-us"]) { const u = origin + path; if (!queue.includes(u)) queue.push(u); }

  let robots = null;
  let pages = 0;
  let sawContact = !url || url === home.url;
  if (url === home.url || !url) form = hasContactForm(home.html);
  for (const u of queue) {
    if (pages >= maxPages) break;
    // Done once we hold an address on the business's own domain and have looked at the contact page.
    if (best && best.rank >= 30 && sawContact) break;
    if (robots === null) robots = await getText(`${origin}/robots.txt`, userAgent, 3000, 32 * 1024);
    let path;
    try { path = new URL(u).pathname; } catch { continue; }
    if (!robotsAllows(robots, path)) continue;
    const page = await getPage(u, userAgent, timeoutMs);
    if (!page) continue;
    pages++;
    const b = bestEmailRanked(page.html, page.url);
    if (b && (!best || b.rank > best.rank)) best = b;
    hidden = hidden || hasObfuscatedEmail(page.html);
    if (u === url || (!url && /contact/i.test(path))) {
      sawContact = true;
      form = form || hasContactForm(page.html);
      url = url || page.url;
    }
  }
  return { email: best ? best.email : null, rank: best ? best.rank : -1, url, form, hidden, pages, error: null };
}
