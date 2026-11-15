// Founder commands sent by email to ops@. Pure parsing, no I/O except reading the raw message.
//
//   SENT <domain>            mark the outreach as sent
//   SKIP <domain>            don't pitch this one
//   STOP <domain-or-email>   never contact (adds to the suppression list)
//   MORE                     send another digest now
//   STATUS                   counts per status and recent runs
//
// Only lines BEFORE the quoted reply count, so commands inside quoted text are ignored.

import { readCappedBytes } from "../../shared/site-check.js";

export const MAX_RAW_BYTES = 256 * 1024;

export async function readRawMessage(raw) {
  return readCappedBytes(raw, MAX_RAW_BYTES);
}

// ---------------------------------------------------------------------------
// MIME: find and decode the first text/plain part

export function extractPlainText(bytes) {
  const raw = typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes);
  return decodeEntity(raw, 0) ?? "";
}

function splitHeaders(entity) {
  const m = /\r?\n\r?\n/.exec(entity);
  const head = m ? entity.slice(0, m.index) : entity;
  const body = m ? entity.slice(m.index + m[0].length) : "";
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

function decodeEntity(entity, depth) {
  if (depth > 5) return null;
  const { headers, body } = splitHeaders(entity);
  const type = (headers["content-type"] || "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const b = /boundary="?([^";\s]+)"?/i.exec(headers["content-type"] || "");
    if (!b) return null;
    const parts = body.split("--" + b[1]);
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].startsWith("--")) break; // closing delimiter
      const text = decodeEntity(parts[i].replace(/^\r?\n/, ""), depth + 1);
      if (text !== null) return text;
    }
    return null;
  }
  if (!type.startsWith("text/plain")) return null;
  const charset = (/charset="?([^";\s]+)"?/i.exec(headers["content-type"] || "") || [])[1] || "utf-8";
  return decodeBody(body, (headers["content-transfer-encoding"] || "7bit").toLowerCase(), charset);
}

function decodeBody(body, encoding, charset) {
  let bytes;
  if (encoding === "base64") {
    try {
      const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return "";
    }
  } else if (encoding === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, "");
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        out.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(...new TextEncoder().encode(s[i]));
      }
    }
    bytes = Uint8Array.from(out);
  } else {
    return body;
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Commands

// Lines of the new message only: stop at the quoted reply.
export function newMessageLines(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) break;
    if (/^On .*wrote:\s*$/i.test(l)) break;
    if (/^On\b/.test(l) && /^\s*.*wrote:\s*$/i.test(lines[i + 1] || "")) break; // wrapped attribution line
    if (/^-----\s*Original Message\s*-----/i.test(l) || /^_{10,}\s*$/.test(l) || l === "-- ") break;
    out.push(l);
  }
  return out;
}

// "https://www.Example.com/path" -> "example.com"; "Bob@Example.com" stays an address.
export function normalizeTarget(arg) {
  let s = String(arg || "").trim().toLowerCase().replace(/^[<("']+|[>)"',.;]+$/g, "");
  if (!s) return null;
  if (s.includes("@")) return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s) && s.length <= 254 ? { kind: "email", value: s } : null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) && s.length <= 253 ? { kind: "domain", value: s } : null;
}

export function parseCommands(text) {
  const commands = [];
  const unknown = [];
  for (const line of newMessageLines(text)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(SENT|SKIP|STOP|MORE|STATUS)\b\s*(.*)$/i.exec(t);
    if (!m) { unknown.push(t.slice(0, 120)); continue; }
    const cmd = m[1].toUpperCase();
    if (cmd === "MORE" || cmd === "STATUS") {
      commands.push({ cmd });
      continue;
    }
    const target = normalizeTarget(m[2].split(/\s+/)[0]);
    if (!target || (cmd !== "STOP" && target.kind !== "domain")) { unknown.push(t.slice(0, 120)); continue; }
    commands.push({ cmd, target });
  }
  return { commands: commands.slice(0, 25), unknown: unknown.slice(0, 5) };
}
