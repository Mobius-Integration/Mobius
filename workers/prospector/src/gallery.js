// #gallery: the visual side of the office. Agents' HTML mockups are rendered to PNG with Browser Run
// and posted there with a link back to their standup; generated images (logo concepts, textures) too.
import puppeteer from "@cloudflare/puppeteer";
import { botKey, discordConfig } from "./discord.js";

const FONT_HOSTS = ["https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
export const MOCKUP_MAX = 14000;

// Mockup HTML is model-written, so it is rendered with scripts off and no network except Google Fonts.
export function allowRequest(url) {
  const u = String(url || "");
  return u.startsWith("data:") || u === "about:blank" || FONT_HOSTS.some((h) => u.startsWith(h));
}

export function wrapMockup(html) {
  const body = String(html || "").slice(0, MOCKUP_MAX).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<script[^>]*>/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:"><style>html,body{margin:0;background:#fff}body{width:1200px;font-family:Inter,system-ui,sans-serif}</style></head><body>${body}</body></html>`;
}

export async function renderMockup(env, html, { launch } = {}) {
  if (!env.BROWSER && !launch) return null;
  const browser = await (launch ? launch() : puppeteer.launch(env.BROWSER, { keep_alive: 30000 }));
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (r) => (allowRequest(r.url()) ? r.continue() : r.abort()));
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    await page.setContent(wrapMockup(html), { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
    const h = await page.evaluate(() => Math.min(2400, Math.max(400, document.body.scrollHeight))).catch(() => 800);
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: h } });
    return png instanceof Uint8Array ? png : new Uint8Array(png);
  } finally { try { await browser.close(); } catch {} }
}

export async function postGallery(env, content, files) {
  const c = await discordConfig(env), channel = c.channels?.gallery, key = await botKey(env);
  if (!channel || !key || !files?.length) return false;
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes], { type: f.type }), f.name));
  const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, { method: "POST", headers: { Authorization: `Bot ${key}` }, body: form });
  return r.ok;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("render timeout")), ms))]);

// Renders one agent's mockup and posts it. Never throws: a failed visual must not stop the standup.
export async function galleryMockup(env, { role, job, html, threadId, guild, label = "From the standup" }) {
  try {
    if (!String(html || "").trim()) return false;
    const png = await withTimeout(renderMockup(env, html), 30000);
    if (!png?.length) return false;
    const who = { studio: "Studio", growth: "Growth", builder: "Builder" }[role] || "Office";
    const link = guild && threadId ? `\n${label}: https://discord.com/channels/${guild}/${threadId}` : "";
    return await postGallery(env, `**${who}** · ${String(job || "").split(/[.:]/)[0].slice(0, 120)}${link}`, [{ bytes: png, type: "image/png", name: `${role}-mockup.png` }]);
  } catch (e) { console.error("prospector: gallery mockup failed:", e?.message || "unknown error"); return false; }
}
