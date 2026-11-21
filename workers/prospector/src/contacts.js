// Contact route lookup, only for prospects picked for a digest (a handful a day, never the whole list):
// the contact page link and an email address the business publishes on its own website, so the founder
// can write to them without hunting. Read-only GETs: the page we already checked, then at most one
// contact page on the same site. It never guesses an address and never decodes an address a site hides
// from bots (Cloudflare's email protection, HTML-entity tricks). Those sites get the contact page link.

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
const rootOf = (h) => h.split(".").slice(-2).join(".");

// Every address on the page: mailto: links and addresses written out as text. Scripts, styles and tags
// are blanked with spaces of the same length, so a match's position still lines up with the HTML.
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
  return { list, text };
}

// The best address for the business at siteUrl, or null. Accepts the site's own domain, common free
// mail providers (many small businesses use one), or a domain that is clearly a variant of the site's.
export function bestEmail(html, siteUrl) {
  const site = hostOf(siteUrl);
  if (!site) return null;
  const siteRoot = rootOf(site);
  const siteLabel = siteRoot.split(".")[0];
  const { list, text } = emailCandidates(html);
  const ranks = new Map();
  for (const c of list) {
    const e = String(c.value).trim().toLowerCase().replace(/^mailto:/, "").replace(/[.,;:]+$/, "");
    if (e.length > 254 || !EMAIL_RE.test(e) || ASSET.test(e)) continue;
    const [local, dom] = e.split("@");
    if (NEVER_LOCAL.test(local) || PLACEHOLDER_LOCAL.test(local) || JUNK_DOMAIN.test(dom)) continue;
    if (DESIGNER.test(text.slice(Math.max(0, c.at - 160), c.at).replace(/\s+/g, " "))) continue;
    let rank;
    if (dom === siteRoot || dom.endsWith("." + siteRoot)) rank = 30;
    else if (FREE_MAIL.has(dom)) rank = 20;
    else {
      const label = rootOf(dom).split(".")[0];
      rank = label.length >= 4 && siteLabel.length >= 4 && (siteLabel.includes(label) || label.includes(siteLabel)) ? 10 : -1;
    }
    if (rank < 0) continue;
    if (ROLE.test(local)) rank += 3;
    if (c.mailto) rank += 1;
    if (!(ranks.get(e) >= rank)) ranks.set(e, rank);
  }
  let best = null;
  let top = -1;
  for (const [e, r] of ranks) if (r > top) { best = e; top = r; }
  return best;
}

// The site's own contact page, or null: a link whose text says "contact" (or "get in touch") or whose
// path has /contact, on the same host. A link with both wins.
export function contactPageLink(html, pageUrl) {
  const site = hostOf(pageUrl);
  if (!site) return null;
  let fallback = null;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi)) {
    const attrs = " " + m[1];
    const href = ((/\shref\s*=\s*["']([^"']+)["']/i.exec(attrs) || /\shref\s*=\s*([^\s>"']+)/i.exec(attrs)) || [])[1];
    if (!href || /^\s*(#|mailto:|tel:|sms:|javascript:)/i.test(href)) continue;
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    const byText = /\b(contact(\s+us)?|get in touch|reach us)\b/i.test(label);
    const byPath = /\/contact/i.test(href);
    if (!byText && !byPath) continue;
    let u;
    try { u = new URL(href.trim(), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.toString()) !== site) continue;
    u.hash = "";
    if (byText && byPath) return u.toString();
    if (!fallback) fallback = u.toString();
  }
  return fallback;
}

export const hasContactForm = (html) => /<form\b[\s\S]*?(type\s*=\s*["']?email|<textarea\b)/i.test(html);

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

// { email, url, form, error }. `url` is the contact page link (null if none); `form` is true when that
// page has a contact form. Never throws.
export async function findContact(p, { userAgent, timeoutMs = 8000 } = {}) {
  const start = p.final_url || p.website;
  const home = await getPage(start, userAgent, timeoutMs);
  if (!home) return { email: null, url: null, form: false, error: "The page didn't load for the contact lookup." };
  let email = bestEmail(home.html, home.url);
  const url = contactPageLink(home.html, home.url);
  let form = false;
  if (url && url !== home.url) {
    const page = await getPage(url, userAgent, timeoutMs);
    if (page) {
      email = email || bestEmail(page.html, page.url);
      form = hasContactForm(page.html);
    }
  } else {
    form = hasContactForm(home.html); // no separate contact page: maybe the form is on this one
  }
  return { email, url, form, error: null };
}
