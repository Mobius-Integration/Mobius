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

  let res;
  let fellBack = false;
  let requested = url.toString();
  try {
    res = await get(url.toString());
  } catch (e) {
    let failure = e;
    // Opt-in: an HTTPS connection or TLS failure (not an HTTP status, not a timeout) may mean the
    // site only speaks plain HTTP. Make one more GET over http:// so it doesn't look closed.
    if (opts.httpFallback && url.protocol === "https:" && !isTimeout(e)) {
      const plain = new URL(url.toString());
      plain.protocol = "http:";
      try {
        res = await get(plain.toString());
        requested = plain.toString();
        fellBack = true;
      } catch (e2) {
        failure = e2;
      }
    }
    if (!res) {
      return {
        ok: false,
        error: isTimeout(failure) ? `The site didn't respond within ${Math.round(timeoutMs / 1000)} seconds.` : "The site refused or dropped the connection.",
        url: url.toString(),
        ms: Date.now() - started,
      };
    }
  }
  if (res.status >= 400) {
    try { await res.body.cancel(); } catch {}
    return { ok: false, error: `The site answered with an error (HTTP ${res.status}).`, url: res.url || url.toString(), status: res.status, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  const finalUrl = res.url || requested;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("html")) {
    try { await res.body.cancel(); } catch {}
    return { ok: false, error: `The address returned ${type || "no content type"}, not a web page.`, url: finalUrl, status: res.status, ms };
  }

  const htmlText = await readCapped(res, maxBytes); // keep parsing inside the free plan CPU budget
  const issues = [];
  const good = [];

  const https = finalUrl.startsWith("https://");
  (https ? good : issues).push(https ? "Loads over HTTPS" : "Doesn't load over HTTPS (browsers mark it not secure)");

  const viewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(htmlText);
  (viewport ? good : issues).push(viewport ? "Has a mobile viewport tag" : "No mobile viewport tag, so it may render tiny on phones");

  const title = (htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (!title || !title.trim()) issues.push("No page title");
  const desc = /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{10,}/i.test(htmlText);
  if (!desc) issues.push("No meta description for search results");

  const imgs = htmlText.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter((t) => !/\salt\s*=/.test(t)).length;
  if (noAlt) issues.push(`${noAlt} of ${imgs.length} images have no alt text`);

  const labelFor = new Set([...htmlText.matchAll(/<label[^>]*\sfor=["']([^"']+)["']/gi)].map((m) => m[1]));
  const fields = (htmlText.match(/<(input|select|textarea)\b[^>]*>/gi) || [])
    .filter((t) => !/type=["']?(hidden|submit|button|image|reset)/i.test(t));
  const unlabeled = fields.filter((t) => {
    if (/aria-label(ledby)?\s*=\s*["'][^"']+/i.test(t)) return false;
    const id = (t.match(/\sid=["']([^"']+)["']/i) || [])[1];
    return !(id && labelFor.has(id));
  }).length;
  if (unlabeled) issues.push(`${unlabeled} form field${unlabeled > 1 ? "s" : ""} on the home page without a label`);

  const booking = BOOKING_HINTS.filter(([, re]) => re.test(htmlText)).map(([n]) => n);
  let noBooking = false;
  if (booking.length) good.push(`Online booking found: ${booking.join(", ")}`);
  else if (!/book (now|online|a table|an appointment)|reserv(e|ation)|schedule (an|your|a)|appointment/i.test(htmlText)) {
    noBooking = true;
    issues.push("No online booking or scheduling found on the home page");
  }

  if (ms > 3000) issues.push(`Slow first response (${(ms / 1000).toFixed(1)}s)`);

  return {
    ok: true, fellBack, url: finalUrl, status: res.status, ms, title: title ? title.trim().slice(0, 120) : "", issues, good, booking,
    // Structured metrics (used by the prospector's score and database; lead-alert ignores them).
    metrics: {
      https, viewport, hasTitle: !!(title && title.trim()), hasDesc: !!desc,
      imgsTotal: imgs.length, imgsNoAlt: noAlt, fieldsUnlabeled: unlabeled, noBooking, bytes: htmlText.length,
    },
  };
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
