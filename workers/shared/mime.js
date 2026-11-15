// Minimal MIME builder shared by the Mobius Workers (UTF-8, multipart/alternative, base64 bodies).
// Header values have CR/LF stripped, so untrusted text can't inject extra headers.

export function buildMime({ from, to, replyTo, subject, text, html, domain }) {
  const boundary = "b_" + crypto.randomUUID().replace(/-/g, "");
  const clean = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
  const headers = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: ${encodeHeader(clean(subject).slice(0, 180))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", b64(body)].join("\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + part("text/plain", text) + "\r\n" + part("text/html", html) + `\r\n--${boundary}--\r\n`;
}

export function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s, false)}?=`;
}

export function b64(s, wrap = true) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const out = btoa(bin);
  return wrap ? out.replace(/.{1,76}/g, "$&\r\n").trimEnd() : out;
}
