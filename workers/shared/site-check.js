// Read-only website check shared by the Mobius Workers (lead-alert and prospector).
//
// checkSite(url, opts) makes ONE GET of the page (redirects followed, nothing else), reads at most
// opts.maxBytes of the body and parses it with cheap string/regex work so it fits the Workers Free
// CPU budget. It never submits forms and never follows links. Everything it returns is derived
// from untrusted HTML: escape it before it goes into an email or a prompt.

export const DEFAULT_MAX_BYTES = 150 * 1024;

// A normal browser identity plus our name, so sites that block unknown bots still let the one-page
// check through while it stays clear who is asking. Callers may pass their own `userAgent`.
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 MobiusCheckup/1.0 (+https://mobiusintegration.com)";

const BOOKING_HINTS = [
  ["Resy", /resy\.com/i], ["OpenTable", /opentable\./i], ["Tock", /exploretock\.com/i],
  ["Calendly", /calendly\.com/i], ["Acuity", /acuityscheduling\.com/i], ["Square Appointments", /squareup\.com\/appointments|square\.site\/book/i],
  ["Vagaro", /vagaro\.com/i], ["Booksy", /booksy\.com/i], ["Mindbody", /mindbodyonline\.com|mindbody\.io/i],
  ["Zocdoc", /zocdoc\.com/i], ["Setmore", /setmore\.com/i], ["Fresha", /fresha\.com/i],
  ["GoHighLevel", /leadconnectorhq\.com|msgsndr\.com/i], ["Housecall Pro", /housecallpro\.com/i], ["Jobber", /getjobber\.com/i],
];

export async function checkSite(input, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const timeoutMs = opts.timeoutMs || 8000;
  const started = Date.now();
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, skipped: true, error: "Skipped: that isn't a valid web address." };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, skipped: true, error: "Skipped: only http and https addresses are checked." };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) {
    return { ok: false, skipped: true, error: "Skipped: not a public website address." };
  }

  const get = (u) => fetch(u, {
    redirect: "follow",
    headers: { "User-Agent": userAgent, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const isTimeout = (e) => e && (e.name === "TimeoutError" || e.name === "AbortError");
  const errText = (e) => `${e && e.message} ${e && e.cause && (e.cause.code || e.cause.message)}`;
  const isDnsError = (e) => /ENOTFOUND|EAI_AGAIN|getaddrinfo|dns|name not resolved/i.test(errText(e));
  const isCertError = (e) => /CERT|certificate|self[- ]signed|UNABLE_TO_VERIFY|ALTNAME/i.test(errText(e));
  // In a Worker, a broken origin comes back as a Cloudflare status instead of an exception:
  // 530 = the domain no longer resolves; 525/526 = TLS handshake failed / invalid certificate.
  const DEAD_SITE = "The web address no longer leads to a working website (its domain doesn't resolve).";

  let res;
  let fellBack = false;
  let certBroken = false;
  let requested = url.toString();
  // Opt-in: an HTTPS failure that isn't a timeout may mean the site only works over plain HTTP (or
  // its certificate is broken). Make one more GET over http:// so it doesn't look closed.
  const tryPlain = async () => {
    const plain = new URL(url.toString());
    plain.protocol = "http:";
    const r = await get(plain.toString());
    requested = plain.toString();
    fellBack = true;
    return r;
  };
  try {
    res = await get(url.toString());
  } catch (e) {
    let failure = e;
    if (isCertError(e)) certBroken = true;
    if (opts.httpFallback && url.protocol === "https:" && !isTimeout(e) && !isDnsError(e)) {
      try { res = await tryPlain(); } catch (e2) { failure = e2; }
    }
    if (!res) {
      return {
        ok: false,
        error: isTimeout(failure) ? `The site didn't respond within ${Math.round(timeoutMs / 1000)} seconds.`
          : isDnsError(failure) ? DEAD_SITE
          : certBroken ? "The site's security certificate is invalid, so browsers show a warning page instead of the site."
          : "The site refused or dropped the connection.",
        url: url.toString(),
        ms: Date.now() - started,
      };
    }
  }
  if ((res.status === 525 || res.status === 526) && !fellBack) {
    certBroken = true;
    try { await res.body.cancel(); } catch {}
    let plainRes = null;
    if (opts.httpFallback && url.protocol === "https:") { try { plainRes = await tryPlain(); } catch {} }
    if (!plainRes || plainRes.status >= 400) {
      if (plainRes) { try { await plainRes.body.cancel(); } catch {} }
      return { ok: false, error: "The site's security certificate is invalid, so browsers show a warning page instead of the site.", url: url.toString(), status: res.status, ms: Date.now() - started };
    }
    res = plainRes;
  }
  if (res.status >= 400) {
    try { await res.body.cancel(); } catch {}
    const error = res.status === 530 ? DEAD_SITE : `The site answered with an error (HTTP ${res.status}).`;
    return { ok: false, error, url: res.url || url.toString(), status: res.status, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  const finalUrl = res.url || requested;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("html")) {
    try { await res.body.cancel(); } catch {}
    return { ok: false, error: `The address returned ${type || "no content type"}, not a web page.`, url: finalUrl, status: res.status, ms };
  }

  // Keep parsing inside the free plan CPU budget. A page longer than the cap is cut off: anything we
  // didn't read is unknown, never reported as missing.
  const bytes = await readCappedBytes(res, maxBytes);
  const truncated = bytes.length >= maxBytes;
  const htmlText = new TextDecoder().decode(bytes);
  const title = (htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const pageText = visibleText(htmlText.slice(0, 80000)); // bounded: the free plan allows 10 ms CPU per run
  const notASite = (why) => ({ ok: false, error: why, url: finalUrl, status: res.status, ms });

  // A parked or placeholder domain is not a real site: a tiny page with no body that only redirects, or a
  // known parking host. Findings from it ("no viewport tag", "no title") would be false, so don't report them.
  if (htmlText.length < 1500 && (!/<body[\s>]/i.test(htmlText) || /\/lander|forsale|parkedpages|afternic|sedo\.com|hugedomains|dan\.com/i.test(htmlText))) {
    return notASite("The address looks like a parked or placeholder page, not a real website.");
  }
  // Hosting placeholders, error pages and "coming soon" pages aren't the business's website either.
  if (PLACEHOLDER_TITLE.test(String(title || "").trim()) || (htmlText.length < 30000 && PLACEHOLDER_TEXT.test(pageText.slice(0, 2000)))) {
    return notASite("The address shows a hosting placeholder, error or coming-soon page, not the business's website.");
  }
  // Optional: a page that never mentions the business (a hijacked or resold domain, a different business)
  // would make every finding about the wrong website.
  if (opts.expectName && !mentionsName(opts.expectName, `${selfNames(htmlText, title)} ${pageText}`)) {
    return notASite("The page at this address doesn't mention the business, so it may be a different site or a domain that changed hands.");
  }

  const issues = [];
  const good = [];

  const https = finalUrl.startsWith("https://");
  if (https) good.push("Loads over HTTPS");
  else issues.push(certBroken ? "The HTTPS address shows a browser security warning (invalid certificate)" : "Doesn't load over HTTPS (browsers mark it not secure)");

  // Head checks only count when the whole <head> was read (huge inline styles can push the viewport tag
  // past the cap). null = unknown.
  const headRead = /<\/head>|<body[\s>]/i.test(htmlText);
  const viewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(htmlText) ? true : headRead ? false : null;
  if (viewport === true) good.push("Has a mobile viewport tag");
  else if (viewport === false) issues.push("No mobile viewport tag, so it may render tiny on phones");

  const hasTitle = title && title.trim() ? true : headRead ? false : null;
  if (hasTitle === false) issues.push("No page title");
  const hasDesc = /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{10,}/i.test(htmlText) ? true : headRead ? false : null;
  if (hasDesc === false) issues.push("No meta description for search results");

  // Count only what a screen reader would meet, and accept every naming technique that axe-core's
  // image-alt and label rules accept, so a finding we quote holds up when someone runs a standard tool.
  // <noscript> fallbacks never render in a normal browser (the Facebook pixel lives there), and
  // hidden elements, 1-pixel trackers and fields taken out of the tab order (spam honeypots) are skipped.
  const visibleHtml = htmlText.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  const hiddenTag = (t) => /\saria-hidden=["']?true|\shidden(\s|>|=|\/)|display\s*:\s*none|visibility\s*:\s*hidden/i.test(t);
  const named = (t) => /\saria-label(ledby)?\s*=\s*["']\s*[^"'\s]/i.test(t) || /\stitle\s*=\s*["']\s*[^"'\s]/i.test(t);

  const imgs = (visibleHtml.match(/<img\b[^>]*>/gi) || [])
    .filter((t) => !hiddenTag(t) && !/\s(width|height)=["']?[01](["'\s>]|px)/i.test(t));
  const noAlt = imgs.filter((t) => !/\salt\s*=/i.test(t) && !named(t) && !/\srole=["']?(presentation|none)\b/i.test(t)).length;
  // On a page cut off at the cap the totals are partial, so say "at least".
  if (noAlt) issues.push(truncated ? `At least ${noAlt} images have no alt text` : `${noAlt} of ${imgs.length} images have no alt text`);

  const labelFor = new Set([...visibleHtml.matchAll(/<label\b[^>]*\sfor=["']?([^"'\s>]+)/gi)].map((m) => m[1]));
  // A field inside a <label> element is labelled by it (an implicit label), so drop those blocks first.
  const outsideLabels = visibleHtml.replace(/<label\b[^>]*>[\s\S]*?<\/label>/gi, "");
  const fields = (outsideLabels.match(/<(input|select|textarea)\b[^>]*>/gi) || [])
    .filter((t) => !/\stype=["']?(hidden|submit|button|image|reset)\b/i.test(t) && !hiddenTag(t) && !/\stabindex=["']?-1\b/i.test(t));
  const unlabeled = fields.filter((t) => {
    if (named(t) || /\splaceholder\s*=\s*["']\s*[^"'\s]/i.test(t)) return false;
    const id = (t.match(/\sid=["']?([^"'\s>]+)/i) || [])[1];
    return !(id && labelFor.has(id));
  }).length;
  if (unlabeled) issues.push(`${truncated ? "At least " : ""}${unlabeled} form field${unlabeled > 1 ? "s" : ""} on the home page without a label`);

  const booking = BOOKING_HINTS.filter(([, re]) => re.test(htmlText)).map(([n]) => n);
  let noBooking = false;
  if (booking.length) good.push(`Online booking found: ${booking.join(", ")}`);
  // A booking widget may sit past the cap, so a cut-off page never reports "no booking".
  else if (!truncated && !/book (now|online|a table|an appointment)|reserv(e|ation)|schedule (an|your|a)|appointment/i.test(htmlText)) {
    noBooking = true;
    issues.push("No online booking or scheduling found on the home page");
  }

  if (ms > 3000) issues.push(`Slow first response (${(ms / 1000).toFixed(1)}s)`);

  return {
    ok: true, fellBack, url: finalUrl, status: res.status, ms, title: title ? title.trim().slice(0, 120) : "", issues, good, booking,
    // Structured metrics (used by the prospector's score and database; lead-alert ignores them).
    // viewport, hasTitle and hasDesc are true, false, or null (unknown: the page was cut off before </head>).
    metrics: {
      https, viewport, hasTitle, hasDesc,
      imgsTotal: imgs.length, imgsNoAlt: noAlt, fieldsUnlabeled: unlabeled, noBooking, bytes: bytes.length, truncated,
    },
  };
}

// Title-only matches: a hosting company's name or a server default as the whole page title.
const PLACEHOLDER_TITLE = /^(inmotion hosting|nexcess|godaddy|hostgator|bluehost|siteground|hostinger|a2 hosting|dreamhost|cpanel|plesk|web hosting|default (web )?(site )?page|account suspended|(web)?site suspended|index of\b|apache2? .*default page|welcome to nginx|iis windows server|coming soon|under construction|site not found|domain (default page|expired|for sale))/i;
// Phrases a placeholder or error page leads with (checked only on small pages, in the first 2,000
// characters of text, so a real site that mentions its host in the footer isn't caught).
const PLACEHOLDER_TEXT = /\b(is almost here|upload your website|page cannot be displayed|contact your (service|hosting) provider|account (has been |is )?suspended|this (site|website|domain) (has been |is )?(suspended|parked|expired)|future home of|(website|site) (is )?coming soon|(website|site) (is )?under construction|launching soon|default web ?(site )?page)\b/i;

// The page's readable text: scripts, styles and markup removed, common entities decoded.
function visibleText(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ").replace(/&amp;|&#0?38;/gi, "&").replace(/&(#0?39|#8217|rsquo|apos);/gi, "'")
    .replace(/\s+/g, " ")
    .slice(0, 50000);
}

// True when the page mentions the business: at least one distinctive word of its name (3+ letters).
// Words that describe a kind of business or a place ("pizza", "jewelry", "law", "Tampa") don't count
// when the name has a distinctive word too, so a resold domain now selling the same kind of thing
// still fails. A name made only of such words ("Indian Cuisine") needs any one of them.
const NAME_STOP = new Set(["the", "and", "llc", "inc", "pllc", "corp", "company", "for", "with"]);
const NAME_GENERIC = new Set((
  "restaurant restaurants grill bar cafe pizza pizzeria kitchen bistro tavern pub eatery diner deli bakery cuisine food foods " +
  "sushi tacos taqueria bbq burger burgers coffee tea wine brewing brewery house mexican italian indian chinese thai japanese " +
  "cuban greek american seafood steakhouse sports lounge club express shop store boutique market jewelry jewelers salon spa " +
  "nails nail hair barber barbershop beauty studio studios fitness gym yoga pilates dance wellness health medical dental " +
  "dentistry family clinic center care chiropractic law firm attorney attorneys lawyer lawyers group associates office offices " +
  "services service solutions realty real estate properties homes construction roofing plumbing electric heating air cooling " +
  "pest landscaping cleaning auto repair tampa bay pete petersburg saint clearwater florida brandon riverview largo dunedin oldsmar " +
  "lakeland plant city wesley chapel zephyrhills lutz odessa trinity seminole pinellas pasco hillsborough polk valrico seffner ruskin " +
  "apollo beach palm harbor tarpon springs port richey hudson dade temple terrace carrollwood westchase gulfport safety"
).split(" "));
const normWords = (s) => ` ${String(s || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/['\u2019`]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
export function mentionsName(name, text) {
  const words = normWords(name).trim().split(" ").filter((w) => w.length >= 3 && !NAME_STOP.has(w));
  if (!words.length) return true; // nothing to compare
  const distinctive = words.filter((w) => !NAME_GENERIC.has(w));
  const t = normWords(text);
  return (distinctive.length ? distinctive : words).some((w) => t.includes(` ${w}`));
}

// Where a site names itself besides its visible text: the title, social/app name tags and image alt text
// (many small sites show their name only as a logo).
function selfNames(html, title) {
  const metas = [...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:site_name|og:title|application-name|apple-mobile-web-app-title)["'][^>]*>/gi)]
    .map((m) => (m[0].match(/content=["']([^"']*)/i) || [])[1] || "");
  const alts = [...html.matchAll(/\salt=["']([^"']{2,80})["']/gi)].slice(0, 200).map((m) => m[1]);
  return [title || "", ...metas, ...alts].join(" ");
}

// Read at most `max` bytes from a Response body (or any ReadableStream) and return them.
export async function readCappedBytes(streamOrResponse, max) {
  const stream = streamOrResponse && streamOrResponse.body ? streamOrResponse.body : streamOrResponse;
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch {}
  const buf = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.length, buf.length - off));
    buf.set(part, off);
    off += part.length;
    if (off >= buf.length) break;
  }
  return buf;
}

export async function readCapped(res, max) {
  return new TextDecoder().decode(await readCappedBytes(res, max));
}
