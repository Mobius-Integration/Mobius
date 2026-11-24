// The short write-up the first email offers: "a short write-up of what I saw, with screenshots".
//
// makeWriteup() opens the business's public home page once in Cloudflare's real browser (Browser Run), at
// computer and phone sizes. It runs axe-core, the open-source accessibility engine many testing tools are
// built on, with the WCAG 2.1 A and AA rules, screenshots an example of each finding with a red outline
// around it, and prints a PDF of two or three pages. It only reads the page; it never clicks, types or
// submits anything.
//
// Every finding in the PDF is something the browser saw on this visit. The first email's findings came
// from the lighter check in shared/site-check.js; each one is measured again here, and one that no
// longer shows up is left out (the founder is told). The founder reads the PDF before it goes anywhere:
// it is attached to a reply draft that he sends himself (src/replykit.js).
//
// createWriteup() makes one for a prospect and keeps the PDF in the WRITEUPS KV namespace for 120 days.

import puppeteer from "@cloudflare/puppeteer";
import AXE_SOURCE from "axe-core/axe.min.js"; // bundled as text (wrangler.toml [[rules]])
import LOGO_SVG from "../../../src/assets/img/logo.svg"; // bundled as text
import { BOOKING_HINTS } from "../../shared/site-check.js";
import { BOOKING_CATEGORIES } from "./score.js";
import { esc, TEXT_SIGNATURE, foundingLine, typeLabel, parseJson } from "./digest.js";
import { isLawFirm, LAW_LINE } from "./partners.js";
import { hostOf } from "./contacts.js";

export const UA_SUFFIX = "MobiusProspector/1.0 (+https://mobiusintegration.com)";
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const NAV_TIMEOUT_MS = 25000;
const AXE_TIMEOUT_MS = 40000;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
export const MAX_FINDINGS = 5;
const MAX_EXAMPLES = 2;
const KEEP_DAYS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, many) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// What each kind of finding says. Plain words for an owner, no fear, no legal talk, nothing we didn't see.

const FAMILY = {
  https: {
    title: (f) => (f.variant === "cert" ? "The secure (https) address shows a browser warning" : "The secure (https) address doesn't open"),
    what: (f) => f.variant === "cert"
      ? "When someone opens the https version of your address, the browser shows a security warning instead of your site, because the site's security certificate doesn't match the address or has expired."
      : "Your site only opens over plain HTTP: the secure https version of your address doesn't open at all. Browsers mark plain HTTP pages “Not secure” in the address bar.",
    why: (f) => f.variant === "cert"
      ? "Many visitors turn back at a warning like that, and browsers increasingly try the https address first."
      : "Visitors see that label right next to your name, which can put them off, especially on a contact form, and browsers set to always use secure connections show a warning before opening the site.",
    fix: (f) => f.variant === "cert"
      ? "Renew or reissue the certificate (it's often free through your web host) so it covers your address."
      : "Turn on a security certificate for your address (usually free from your web host) and send every page to its https address.",
  },
  viewport: {
    title: () => "The site isn't set up for phone screens",
    what: () => "The page is missing the setting that tells phones how to size it, so phones show a shrunken copy of the desktop page that visitors have to pinch and zoom to read. The phone screenshot on the first page shows it.",
    why: () => "Many of your visitors are probably on their phones, and a page that's tiny there is hard to use.",
    fix: () => "Add the standard viewport tag to the page, then check the layout on a phone. An older layout may need some updating too.",
  },
  alt: {
    rules: ["image-alt", "input-image-alt", "role-img-alt", "svg-img-alt", "area-alt", "object-alt"],
    title: (f) => `${f.count} ${plural(f.count, "image has", "images have")} no text description`,
    what: () => "Images can carry a short text description (called alt text). Screen readers, which blind and low-vision visitors use, read it out loud. These images have none, so those visitors hear nothing, or just a file name.",
    why: () => "Search engines also use these descriptions to understand what your images show.",
    fix: () => "Add a short description to each image that shows something useful (a dish, your team, your office), and mark purely decorative images as decorative. In most website editors it's a field in each image's settings.",
    example: "An image with no description",
  },
  label: {
    rules: ["label", "select-name"],
    title: (f) => `${f.count} form ${plural(f.count, "field has", "fields have")} no label`,
    what: () => "These form fields have nothing in the page's code that says what goes in them. A screen reader announces each one as just “edit text”, so the visitor can't tell what to type.",
    why: () => "People who use a screen reader or voice control can't fill in the form reliably, and autofill works better on labeled fields too.",
    fix: () => "Give each field a label (it can be visually hidden if the design needs it). In most form tools it's a setting on each field.",
    example: "A field with no label",
  },
  contrast: {
    rules: ["color-contrast"],
    title: (f) => `${f.count} ${plural(f.count, "piece", "pieces")} of text ${plural(f.count, "is", "are")} hard to read (low contrast)`,
    what: () => "This text is too close in color to its background, so it's hard to read, especially on a phone outdoors or for older eyes.",
    why: () => "If a visitor can't read your hours, prices or phone number at a glance, they're more likely to move on.",
    fix: () => "Darken the text or change the background until the contrast reaches the standard ratio of at least 4.5 to 1 for normal-size text. A designer can usually keep the look while doing it.",
    example: "Low-contrast text",
  },
  zoom: {
    rules: ["meta-viewport"],
    title: () => "Zooming in is turned off on phones",
    what: () => "The page tells phones not to let visitors zoom in, so people who need bigger text can't pinch to zoom.",
    fix: () => "Remove the setting that blocks zoom (maximum-scale or user-scalable=no in the page's viewport tag).",
  },
  link: {
    rules: ["link-name"],
    title: (f) => `${f.count} ${plural(f.count, "link has", "links have")} no name a screen reader can read`,
    what: () => "These links have no text a screen reader can read (often an icon, like a social media logo, with no label), so the visitor hears just “link” with no idea where it goes.",
    fix: () => "Add a short label to each one, such as “Instagram” or “Call us”. It can be hidden visually.",
    example: "A link with no readable name",
  },
  button: {
    rules: ["button-name"],
    title: (f) => `${f.count} ${plural(f.count, "button has", "buttons have")} no name a screen reader can read`,
    what: () => "These buttons have no text a screen reader can read (often an icon-only button, like a menu button), so the visitor hears just “button”.",
    fix: () => "Add a short label to each button, such as “Open menu”. It can be hidden visually.",
    example: "A button with no readable name",
  },
  booking: {
    title: () => "There's no way to book online from the home page",
    what: () => "We didn't find a booking button or a scheduling tool on your home page.",
    why: () => "Visitors who'd book outside business hours have to remember to call back later.",
    fix: () => "A clear “Book now” button linking to a scheduling tool. Many of them work with the calendar you already use.",
  },
  slow: {
    title: (f) => `The home page took ${f.seconds} seconds to finish loading`,
    what: (f) => `In our visit, on a fast connection, the home page took ${f.seconds} seconds to finish loading.`,
    why: () => "On a phone with a weaker signal it takes longer, and visitors tend to leave pages that are slow to appear.",
    fix: () => "Usually it comes down to oversized images and a few heavy scripts, which can be trimmed without changing the look.",
  },
  lang: {
    rules: ["html-has-lang", "html-lang-valid"],
    title: () => "The page doesn't say what language it's in",
    what: () => "The page doesn't declare its language in its code. Screen readers use it to pick the right voice and pronunciation.",
    fix: () => "One attribute at the top of the page (lang=\"en\"). It's a one-minute change.",
  },
  frame: {
    rules: ["frame-title"],
    title: (f) => `${f.count} embedded ${plural(f.count, "frame has", "frames have")} no title`,
    what: () => "These embedded frames (a map, a video or a booking widget, for example) have no title, so screen reader users can't tell what's inside before going in.",
    fix: () => "Add a short title to each embed, such as “Map to our office”.",
    example: "An embed with no title",
  },
  title: {
    rules: ["document-title"],
    title: () => "The page has no title",
    what: () => "The title is what shows in the browser tab, and usually as the headline of your listing in Google. This page doesn't have one.",
    fix: () => "Add a short title with your business name and what you do.",
  },
  desc: {
    title: () => "There's no description for search results",
    what: () => "The page has no description in its settings, so Google writes its own summary of your page, which may not say what you'd want.",
    fix: () => "Add a one- or two-sentence description of your business to the page's settings.",
  },
};

// The order findings appear in when the first email didn't quote them (concrete and visible first).
const ORDER = ["https", "viewport", "alt", "label", "contrast", "zoom", "link", "button", "booking", "slow", "lang", "frame", "title", "desc"];
export const FAMILY_LABELS = {
  https: "HTTPS", viewport: "the phone layout", alt: "image descriptions", label: "form labels", contrast: "text contrast", zoom: "zooming on phones",
  link: "link names", button: "button names", booking: "online booking", slow: "page speed", lang: "the page language", frame: "embed titles",
  title: "the page title", desc: "the search description",
};

// Which findings go in the write-up, in what order. `quoted` lists the families the first email quoted.
// Returns { findings, missingQuoted, good }.
export function chooseFindings({ p, quoted = [], visit, facts, audit = [] }) {
  const byRule = new Map(audit.map((v) => [v.id, v]));
  const present = new Map();
  if (visit.httpsProblem) present.set("https", { variant: visit.httpsProblem });
  if (facts.viewport === false) present.set("viewport", {});
  for (const fam of ["alt", "label", "contrast", "zoom", "link", "button", "lang", "frame", "title"]) {
    const vs = FAMILY[fam].rules.map((r) => byRule.get(r)).filter(Boolean);
    if (!vs.length) continue;
    const count = vs.reduce((n, v) => n + (Number(v.count) || 0), 0);
    if (count < 1) continue;
    present.set(fam, { count, targets: vs.flatMap((v) => v.targets || []) });
  }
  if (p && BOOKING_CATEGORIES.has(p.category) && !facts.booking) present.set("booking", {});
  if (Number(visit.loadMs) > 5000) present.set("slow", { seconds: (Math.round(Number(visit.loadMs) / 100) / 10).toFixed(1) });
  if (facts.desc === false) present.set("desc", {});

  const order = [...new Set([...(quoted || []).filter((f) => FAMILY[f]), ...ORDER])];
  const findings = [];
  for (const fam of order) {
    if (!present.has(fam) || findings.length >= MAX_FINDINGS) continue;
    const f = { family: fam, ...present.get(fam) };
    const d = FAMILY[fam];
    findings.push({ ...f, title: d.title(f), what: d.what(f), why: d.why ? d.why(f) : "", fix: d.fix(f), example: d.example || "" });
  }
  const missingQuoted = (quoted || []).filter((f) => FAMILY[f] && !present.has(f));

  const good = [];
  if (visit.https && !visit.httpsProblem) good.push("It loads securely over HTTPS.");
  if (facts.viewport && !present.has("zoom")) good.push("It's set up for phone screens.");
  if (facts.widgets && facts.widgets.length) good.push(`Visitors can book online (${facts.widgets.slice(0, 2).join(", ")}).`);
  if (Number(visit.loadMs) > 0 && Number(visit.loadMs) < 2500) good.push("It loaded quickly in our visit.");
  if (!present.has("alt") && facts.images > 0) good.push("Every image we checked has a text description.");
  return { findings, missingQuoted, good: good.slice(0, 3), present: [...present.keys()] };
}

// ---------------------------------------------------------------------------
// The browser visit

// Open their home page, https first. What happened to https is itself a finding:
//   - it opens: no HTTPS finding (browsers try https first, so visitors get the secure page)
//   - a certificate error ("cert"): the page is opened anyway, certificate errors ignored for this
//     visit only, so everything else can still be checked
//   - it doesn't open at all ("broken": connection refused, an old cipher, a timeout): the page is
//     opened over plain http
// Current Chrome refuses plain-http navigations under automation (ERR_BLOCKED_BY_CLIENT: its "always
// use secure connections" mode). Then the page is rendered from a copy fetched over http, with a <base>
// so its images and styles still load from their site (`copy: true`; no load time is reported).
async function openSite(page, p, fetchImpl = fetch) {
  const start = String(p.final_url || p.website || `https://${p.domain}/`);
  const https = start.replace(/^http:\/\//i, "https://");
  const http = https.replace(/^https:\/\//i, "http://");
  let httpsProblem = null;
  let last = "";
  const attempt = async (url) => {
    const t0 = Date.now();
    const resp = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    const status = resp ? resp.status() : 0;
    if (status >= 400) throw new Error(`HTTP ${status}`);
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 6000 }).catch(() => {});
    const loadMs = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return n ? Math.round(n.loadEventEnd || n.domContentLoadedEventEnd || n.responseEnd || 0) : 0;
    }).catch(() => 0);
    const finalUrl = page.url();
    if (!/^https?:/i.test(finalUrl)) throw new Error(`the browser ended on ${finalUrl.slice(0, 40)}`);
    return { ok: true, url: finalUrl, status, https: /^https:/i.test(finalUrl) && !httpsProblem, httpsProblem, loadMs: loadMs || Date.now() - t0 };
  };
  const msg = (e) => String((e && e.message) || e).split(" at ")[0].slice(0, 160);

  try {
    return await attempt(https);
  } catch (e) {
    last = msg(e);
    httpsProblem = /ERR_CERT|certificate/i.test(last) ? "cert" : "broken";
  }
  if (httpsProblem === "cert") {
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
      return await attempt(https);
    } catch (e) {
      last = msg(e);
    }
  }
  try {
    return await attempt(http);
  } catch (e) {
    last = msg(e);
  }
  // The browser won't open plain http: render a copy of the page instead.
  try {
    const t0 = Date.now();
    const res = await fetchImpl(http, { headers: { "User-Agent": `Mozilla/5.0 (compatible; ${UA_SUFFIX})`, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.includes("html")) throw new Error(`HTTP ${res.status}${type ? ` (${type.split(";")[0]})` : ""}`);
    const html = (await res.text()).slice(0, 2_000_000);
    const base = `<base href="${esc(res.url || http)}">`;
    const withBase = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${html}`;
    // "load" can wait forever on one slow image or script; the page is usable once its HTML is parsed.
    await page.setContent(withBase, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 8000 }).catch(() => {});
    return { ok: true, url: res.url || http, status: res.status, https: false, httpsProblem: httpsProblem || "broken", loadMs: 0, copy: true, html: withBase, fetchMs: Date.now() - t0 };
  } catch (e) {
    last = `${last}; copy: ${msg(e)}`;
  }
  return { ok: false, error: `Their site didn't open in the browser (${last}).` };
}

async function pageFacts(page) {
  const hints = BOOKING_HINTS.map(([n, re]) => [n, re.source, re.flags]);
  return page.evaluate((hints) => {
    const meta = (n) => document.querySelector(`meta[name="${n}" i]`);
    const vp = meta("viewport");
    const d = meta("description");
    const html = document.documentElement.outerHTML.slice(0, 600000);
    const text = document.body ? document.body.innerText.slice(0, 30000) : "";
    const widgets = hints.filter(([, src, flags]) => new RegExp(src, flags).test(html)).map(([n]) => n);
    const words = /book (now|online|a table|an appointment)|reserv(e|ation)|schedule (an|your|a)|appointment/i.test(text);
    const images = [...document.images].filter((i) => i.width > 1 && i.height > 1).length;
    return {
      viewport: !!vp,
      desc: !!(d && String(d.getAttribute("content") || "").trim().length >= 10),
      title: String(document.title || "").trim().slice(0, 140),
      widgets, booking: widgets.length > 0 || words, images,
    };
  }, hints);
}

async function runAxe(page) {
  await page.evaluate(AXE_SOURCE);
  const run = page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, count: v.nodes.length,
      // Only plain selectors in the page itself (not inside frames or shadow roots) can be outlined.
      targets: v.nodes.slice(0, 15).map((n) => n.target).filter((t) => t.length === 1 && typeof t[0] === "string").map((t) => t[0]),
    }));
  }, AXE_TAGS);
  return Promise.race([run, sleep(AXE_TIMEOUT_MS).then(() => { throw new Error("the accessibility check took too long"); })]);
}

// A screenshot of up to MAX_EXAMPLES elements, each with a red outline drawn around it (an overlay, so
// the page's own styles are left alone) and some of the page around it for context.
async function exampleShots(page, targets) {
  const out = [];
  // Prefer examples a reader can actually see: visible, reasonably big, near the top of the page.
  const ranked = await page.evaluate((sels) => sels.map((sel, i) => {
    let el = null;
    try { el = document.querySelector(sel); } catch { return null; }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return null;
    const area = Math.min(r.width, 900) * Math.min(r.height, 500);
    const top = r.top + scrollY;
    return { sel, score: (area >= 1600 ? 2 : area >= 400 ? 1 : 0) * 1e6 - top - i };
  }).filter(Boolean).sort((a, b) => b.score - a.score).map((x) => x.sel), targets || []).catch(() => targets || []);
  for (const sel of ranked) {
    if (out.length >= MAX_EXAMPLES) break;
    const box = await page.evaluate(async (sel) => {
      let el = null;
      try { el = document.querySelector(sel); } catch { return null; }
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      if (el.tagName === "IMG" && !el.complete) await new Promise((r) => { el.addEventListener("load", r, { once: true }); setTimeout(r, 1500); });
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 6 || r.height < 6 || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
      const x = r.left + scrollX, y = r.top + scrollY;
      const mark = document.createElement("div");
      mark.id = "__mobius_mark";
      mark.setAttribute("style", `position:absolute;left:${x - 5}px;top:${y - 5}px;width:${r.width + 10}px;height:${r.height + 10}px;border:4px solid #e11d48;border-radius:6px;box-sizing:border-box;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 2px #fff`);
      document.documentElement.appendChild(mark);
      return { x, y, w: r.width, h: r.height, sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight };
    }, sel).catch(() => null);
    if (!box) continue;
    await sleep(250);
    try {
      // The element plus some context, at least 460 x 240, at most 1100 x 560, inside what's on screen.
      const pad = 48;
      let w = Math.min(1100, Math.max(460, box.w + pad * 2));
      let h = Math.min(560, Math.max(240, box.h + pad * 2));
      let x = box.x + box.w / 2 - w / 2;
      let y = box.y + box.h / 2 - h / 2;
      x = Math.max(box.sx, Math.min(x, box.sx + box.vw - w));
      y = Math.max(box.sy, Math.min(y, box.sy + box.vh - h));
      w = Math.min(w, box.vw);
      h = Math.min(h, box.vh);
      const b64 = await page.screenshot({ type: "jpeg", quality: 72, encoding: "base64", captureBeyondViewport: false, clip: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) } });
      out.push({ src: `data:image/jpeg;base64,${b64}`, w: Math.round(w), h: Math.round(h) });
    } catch (e) {
      console.error("writeup: example screenshot failed:", e && e.message);
    } finally {
      await page.evaluate(() => { const m = document.getElementById("__mobius_mark"); if (m) m.remove(); }).catch(() => {});
    }
  }
  return out;
}

async function viewportShot(page) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(300);
  return `data:image/jpeg;base64,${await page.screenshot({ type: "jpeg", quality: 70, encoding: "base64", captureBeyondViewport: false })}`;
}

// Make the write-up. p: { id, name, domain, website, final_url, category, kind }. opts.quoted: the
// families the first email quoted. opts.launch: a function returning a puppeteer-compatible browser
// (tests use a local Chrome). Returns { pdf, findings, good, missingQuoted, url, ms }.
export async function makeWriteup(env, p, opts = {}) {
  const started = Date.now();
  if (!opts.launch && !(env && env.BROWSER)) throw new Error("The browser service (BROWSER binding) isn't set up.");
  const browser = await (opts.launch ? opts.launch() : puppeteer.launch(env.BROWSER, { keep_alive: 120000 }));
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    const ua = String(await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
    await page.setUserAgent(`${ua} ${UA_SUFFIX}`);
    await page.setViewport(DESKTOP);
    const visit = await openSite(page, p);
    if (!visit.ok) throw new Error(visit.error);
    if (hostOf(visit.url) && rootDomain(hostOf(visit.url)) !== rootDomain(p.domain)) {
      throw new Error(`Their website now opens ${hostOf(visit.url)}, so it may be a different business.`);
    }
    const desktop = await viewportShot(page);
    const facts = await pageFacts(page);
    const audit = await runAxe(page);
    const chosen = chooseFindings({ p, quoted: opts.quoted || [], visit, facts, audit });
    for (const f of chosen.findings) f.examples = FAMILY[f.family].example && f.targets && f.targets.length ? await exampleShots(page, f.targets) : [];

    await page.setViewport(PHONE);
    if (visit.copy) await page.setContent(visit.html, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    else await page.reload({ waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 5000 }).catch(() => {});
    const phone = await viewportShot(page);

    const html = reportHtml({ env, p, visit, chosen, desktop, phone, when: new Date() });
    const doc = await browser.newPage();
    await doc.setContent(html, { waitUntil: "networkidle0", timeout: 20000 }).catch(async () => { await doc.setContent(html, { waitUntil: "load" }); });
    const pdf = await doc.pdf({
      format: "Letter", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font-size:8px;color:#6b7280;text-align:center;font-family:Arial,sans-serif">Mobius Integration · mobiusintegration.com · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
      margin: { top: "0.5in", right: "0.6in", bottom: "0.65in", left: "0.6in" },
    });
    const findings = chosen.findings.map(({ examples, targets, ...f }) => ({ ...f, shots: (examples || []).length }));
    return { pdf: new Uint8Array(pdf), findings, good: chosen.good, missingQuoted: chosen.missingQuoted, url: visit.url, ms: Date.now() - started };
  } finally {
    try { await browser.close(); } catch {}
  }
}

// The pre-send check (since 2026-11-24): before an email that quotes findings goes out, does a real
// browser still see each one? The light check (shared/site-check.js) reads the HTML as delivered and can
// be wrong on sites that fix things with JavaScript (one restaurant had alt text on every image in the
// browser, none in the raw HTML). Returns { ran, missing } where missing lists quoted families the
// browser doesn't see. When the browser can't run or can't open the page, ran is false and the caller
// keeps the light check's answer: an outage never stops sending. "slow" isn't re-measured here (the
// light check times the first response; a browser times the whole page).
const NOT_REMEASURED = new Set(["slow"]);
export async function verifyInBrowser(env, p, families, opts = {}) {
  const want = [...new Set(families || [])].filter((f) => FAMILY[f] && !NOT_REMEASURED.has(f));
  if (!want.length) return { ran: false, skipped: "nothing to re-check", missing: [] };
  const launch = opts.launch || (env && env.BROWSER_LAUNCH);
  if (!launch && !(env && env.BROWSER)) return { ran: false, skipped: "no browser", missing: [] };
  let browser = null;
  try {
    browser = await (launch ? launch() : puppeteer.launch(env.BROWSER, { keep_alive: 60000 }));
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    const ua = String(await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
    await page.setUserAgent(`${ua} ${UA_SUFFIX}`);
    await page.setViewport(DESKTOP);
    const visit = await openSite(page, p);
    if (!visit.ok) return { ran: false, error: visit.error, missing: [] };
    const facts = await pageFacts(page);
    const audit = want.some((f) => FAMILY[f].rules) ? await runAxe(page) : [];
    const { present } = chooseFindings({ p, visit, facts, audit });
    return { ran: true, missing: want.filter((f) => !present.includes(f)), present };
  } catch (e) {
    return { ran: false, error: String((e && e.message) || e).slice(0, 200), missing: [] };
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

const rootDomain = (h) => String(h || "").toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");

// ---------------------------------------------------------------------------
// The PDF's page

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function etLabel(d) {
  try {
    const date = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    return { date, time: `${time} Eastern` };
  } catch {
    return { date: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`, time: `${d.toISOString().slice(11, 16)} UTC` };
  }
}

// "Amy G. Cohen, P.a." -> "Amy G. Cohen, P.A.": Overture title-cases the legal suffix at the end of a name.
export function displayName(name) {
  return String(name || "").replace(/\s+/g, " ").trim()
    .replace(/\b(p\.?\s?a|p\.?\s?l|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?p|p\.?\s?c)\.?$/i, (m) => m.toUpperCase());
}

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname)).slice(0, 80);
  } catch {
    return "";
  }
};

export function fileName(name) {
  const clean = displayName(name || "your business").replace(/[^\w &'().,-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `Website write-up - ${clean || "your business"}.pdf`;
}

export function reportHtml({ env, p, visit, chosen, desktop, phone, when = new Date() }) {
  const { date, time } = etLabel(when);
  const name = esc(displayName(p.name));
  const site = esc(hostOf(visit.url) || p.domain);
  const n = chosen.findings.length;
  const founding = foundingLine(env);
  const law = isLawFirm(p) ? LAW_LINE : "";
  const findingHtml = chosen.findings.map((f, i) => `
<section class="finding">
  <h2><span class="num">${i + 1}</span><span>${esc(f.title)}</span></h2>
  <p>${esc(f.what)}${f.why ? ` ${esc(f.why)}` : ""}</p>
  ${(f.examples || []).length ? `<div class="examples">${f.examples.map((x, k) => `<figure><img src="${x.src}" alt=""><figcaption>${esc(f.example || "Example")}, outlined in red${f.count > 1 ? ` (example ${k + 1} of ${f.count})` : ""}.</figcaption></figure>`).join("")}</div>` : ""}
  <p class="fix"><strong>The fix:</strong> ${esc(f.fix)}</p>
</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(fileName(p.name).replace(/\.pdf$/, ""))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--ink:#111827;--muted:#4b5563;--line:#e5e7eb;--brand:#4338ca;--soft:#eef2ff;--ok:#047857;--okbg:#ecfdf5}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,"Helvetica Neue",Arial,"Liberation Sans",sans-serif;color:var(--ink);font-size:10.5pt;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:2px solid var(--brand);padding-bottom:10px}
header .logo svg{height:46px;width:auto;display:block}
.prepared{text-align:right;color:var(--muted);font-size:9pt;line-height:1.4}
.prepared strong{color:var(--ink)}
h1{font-size:21pt;line-height:1.15;letter-spacing:-.01em;margin:18px 0 6px;text-wrap:balance}
.lede{font-size:11pt;color:#374151;margin:0 0 14px;max-width:6.6in}
.shots{display:flex;gap:16px;align-items:flex-start}
figure{margin:0}
.shots .desk img{width:5.15in;display:block;border:1px solid var(--line);border-radius:6px}
.shots .phone img{width:1.35in;display:block;border:1px solid var(--line);border-radius:12px}
figcaption{font-size:8.5pt;color:var(--muted);margin-top:4px}
.glance{margin-top:16px;background:var(--soft);border-radius:10px;padding:12px 16px;break-inside:avoid}
.glance h2{font-size:12pt;margin:0 0 6px}
.glance ol{margin:0;padding-left:20px}
.glance li{margin:2px 0}
.good{margin:10px 0 0;color:var(--ok);font-size:10pt}
.good strong{color:var(--ok)}
.findings-start{margin-top:6px}
.finding{break-inside:avoid;border-top:1px solid var(--line);padding-top:12px;margin-top:14px}
.finding h2{font-size:13.5pt;line-height:1.25;margin:0 0 6px;display:flex;gap:10px;align-items:flex-start}
.num{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--brand);color:#fff;font-size:10pt;font-weight:700;margin-top:1px}
.finding p{margin:0 0 8px}
.examples{display:flex;gap:12px;margin:8px 0 10px;align-items:flex-start}
.examples figure{flex:1 1 0;min-width:0}
.examples img{display:block;max-width:100%;max-height:2.2in;border:1px solid var(--line);border-radius:6px}
.fix{background:var(--okbg);border-left:3px solid var(--ok);padding:8px 12px;border-radius:4px}
.how{break-inside:avoid;margin-top:18px;font-size:9pt;color:var(--muted)}
.how h2{font-size:11pt;color:var(--ink);margin:0 0 4px}
.how ul{margin:0;padding-left:18px}
.next{break-inside:avoid;margin-top:16px;border:2px solid var(--brand);border-radius:10px;padding:12px 16px}
.next h2{font-size:12pt;margin:0 0 6px}
.next p{margin:0 0 8px}
.sig{white-space:pre-line;margin:10px 0 0;font-weight:600}
</style></head><body>
<header><div class="logo">${LOGO_SVG}</div><div class="prepared">Prepared for <strong>${name}</strong><br>${esc(date)}</div></header>
<h1>A quick look at ${name}’s website</h1>
<p class="lede">Here’s the short write-up I mentioned: what a quick, read-only look at your public home page (${site}) showed, with screenshots. ${n ? `I found ${n === 1 ? "one thing" : `${n} things`} worth fixing. Each one is common, and each has a well-known fix.` : "Nothing major stood out on this visit."}</p>
<div class="shots"><figure class="desk"><img src="${desktop}" alt=""><figcaption>On a computer</figcaption></figure><figure class="phone"><img src="${phone}" alt=""><figcaption>On a phone</figcaption></figure></div>
${n ? `<div class="glance"><h2>At a glance</h2><ol>${chosen.findings.map((f) => `<li>${esc(f.title)}</li>`).join("")}</ol>${chosen.good.length ? `<p class="good"><strong>Already working well:</strong> ${chosen.good.map(esc).join(" ")}</p>` : ""}</div>` : ""}
${n ? `<div class="findings-start">${findingHtml}</div>` : ""}
<section class="how"><h2>How I checked</h2><ul>
<li>One page only (${esc(shortUrl(visit.url) || p.domain)}), opened once in a standard Chrome browser on ${esc(date)} at ${esc(time)}, at computer and phone sizes. Nothing was clicked, typed or submitted.</li>
<li>The accessibility checks use axe-core, the open-source engine many accessibility testing tools are built on, with the WCAG 2.1 A and AA rules.</li>
<li>Automated checks find many problems, but not all of them, so a person should also try the site with a keyboard and a screen reader. This write-up is about how the site works for visitors; it isn’t legal advice.</li>
</ul></section>
<section class="next"><h2>If you’d like help</h2>
<p>Reply to my email and I’ll tell you exactly what fixing these involves, with a fixed price in writing before any work starts. If someone else looks after your site, you’re welcome to pass this along to them.</p>
${founding ? `<p>${esc(founding)}</p>` : ""}${law ? `<p>${esc(law)}</p>` : ""}
<p class="sig">${esc(TEXT_SIGNATURE)}</p>
</section>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Storing and finding write-ups

const toBase64 = (bytes) => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export { toBase64 };

const PROSPECT_SQL = `SELECT p.id, p.name, p.domain, p.website, p.category, p.kind, p.track, p.city, c.final_url,
    (SELECT o.quoted FROM outreach o WHERE o.prospect_id = p.id ORDER BY o.id DESC LIMIT 1) AS quoted
  FROM prospects p LEFT JOIN checks c ON c.id = (SELECT MAX(id) FROM checks WHERE prospect_id = p.id)
 WHERE p.id = ?`;

// Make and keep a write-up for one prospect. Returns { ok, id, pdf, findings, good, missingQuoted,
// filename, name } or { ok: false, error }.
export async function createWriteup(env, prospectId, { via = "board", launch } = {}) {
  const db = env.DB;
  const p = await db.prepare(PROSPECT_SQL).bind(prospectId).first();
  if (!p) return { ok: false, error: "That prospect isn't in the database." };
  if (!env.WRITEUPS) return { ok: false, error: "The write-up storage (WRITEUPS) isn't set up." };
  const started = Date.now();
  let r;
  try {
    r = await makeWriteup(env, p, { launch, quoted: parseJson(p.quoted, []) || [] });
  } catch (e) {
    const error = String((e && e.message) || e).slice(0, 300);
    console.error(`writeup: ${p.domain} failed:`, error);
    await db.prepare("INSERT INTO writeups (prospect_id, error, ms, via) VALUES (?, ?, ?, ?)").bind(p.id, error, Date.now() - started, via).run();
    return { ok: false, error };
  }
  const summary = { findings: r.findings, good: r.good, missingQuoted: r.missingQuoted };
  const ins = await db.prepare("INSERT INTO writeups (prospect_id, bytes, url, findings_json, ms, via) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(p.id, r.pdf.byteLength, String(r.url || "").slice(0, 500), JSON.stringify(summary), r.ms, via).run();
  const id = ins.meta && ins.meta.last_row_id;
  const key = `w/${p.id}/${id}.pdf`;
  await env.WRITEUPS.put(key, r.pdf, { expirationTtl: KEEP_DAYS * 86400, metadata: { prospect: p.id } });
  await db.prepare("UPDATE writeups SET kv_key = ? WHERE id = ?").bind(key, id).run();
  return { ok: true, id, key, pdf: r.pdf, ...summary, filename: fileName(p.name), name: p.name };
}

// The newest stored write-up for a prospect made in the last `days` days, with its PDF, or null.
export async function recentWriteup(env, prospectId, days = 3) {
  const row = await env.DB.prepare(
    "SELECT w.id, w.kv_key, w.findings_json, p.name FROM writeups w JOIN prospects p ON p.id = w.prospect_id WHERE w.prospect_id = ? AND w.kv_key IS NOT NULL AND w.created_at >= datetime('now', ?) ORDER BY w.id DESC LIMIT 1",
  ).bind(prospectId, `-${Math.max(1, days)} days`).first();
  if (!row || !env.WRITEUPS) return null;
  const buf = await env.WRITEUPS.get(row.kv_key, "arrayBuffer");
  if (!buf) return null;
  const s = parseJson(row.findings_json, {}) || {};
  return { ok: true, id: row.id, key: row.kv_key, pdf: new Uint8Array(buf), findings: s.findings || [], good: s.good || [], missingQuoted: s.missingQuoted || [], filename: fileName(row.name), name: row.name, reused: true };
}

// The PDF of write-up `id` for the board, or null.
export async function writeupPdf(env, id) {
  const row = await env.DB.prepare("SELECT w.kv_key, p.name FROM writeups w JOIN prospects p ON p.id = w.prospect_id WHERE w.id = ? AND w.kv_key IS NOT NULL").bind(id).first();
  if (!row || !env.WRITEUPS) return null;
  const buf = await env.WRITEUPS.get(row.kv_key, "arrayBuffer");
  return buf ? { bytes: buf, filename: fileName(row.name) } : null;
}
