import { markProspect } from "./marks.js";
import { metaSet, pauseAuto } from "./outbox.js";

const API = "https://discord.com/api/v10";
const CHANNELS = ["hq", "approvals", "replies", "outreach", "builds"];
const CATEGORIES = ["HQ", "Operations", "Projects"];
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const configured = (env) => !!(env.DISCORD_APP_ID && env.DISCORD_PUBLIC_KEY && env.DISCORD_BOT_TOKEN);

export async function verifyDiscordRequest(request, publicKeyHex) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature) || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex || "")) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hex(signature), new TextEncoder().encode(timestamp + await request.clone().text()));
  } catch { return false; }
}

function hex(s) { return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16)); }
async function discordConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first();
  try { return JSON.parse(row?.value || "{}"); } catch { return {}; }
}

export async function handleDiscord(request, env, ctx) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!env.DISCORD_PUBLIC_KEY || !(await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY))) return json(401, { error: "Invalid request signature" });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Bad JSON" }); }
  if (body.type === 1) return json(200, { type: 1 });
  if (body.type !== 3) return json(400, { error: "Unsupported interaction" });
  const cfg = await discordConfig(env);
  if (!Array.isArray(cfg.admins) || !cfg.admins.includes(String(body.member?.user?.id || body.user?.id || ""))) return json(200, { type: 4, data: { content: "Not allowed.", flags: 64 } });
  const id = String(body.data?.custom_id || "");
  const match = /^(auto:(pause|resume)|prospect:(cancel|nofollow):(\d{1,9}))$/.exec(id);
  if (!match) return json(200, { type: 4, data: { content: "Invalid action.", flags: 64 } });
  const [, , autoAction, markAction, prospectId] = match;
  const task = async () => {
    if (autoAction === "pause") await pauseAuto(env, "Paused from Discord.");
    else if (autoAction === "resume") { await metaSet(env.DB, "auto_paused", null); await metaSet(env.DB, "auto_pause_reason", null); }
    else {
      const result = await markProspect(env, Number(prospectId), markAction, "discord");
      if (!result.ok) throw new Error(result.error);
    }
  };
  if (autoAction === "pause" || autoAction === "resume") {
    try { await task(); return json(200, { type: 7, data: { content: autoAction === "pause" ? "Auto-send paused." : "Auto-send resumed.", components: [] } }); }
    catch { return json(200, { type: 4, data: { content: "That action failed.", flags: 64 } }); }
  }
  if (!ctx?.waitUntil) {
    try { await task(); return json(200, { type: 7, data: { content: "Done.", components: [] } }); }
    catch { return json(200, { type: 4, data: { content: "That action failed.", flags: 64 } }); }
  }
  const updateOriginal = async (content) => {
    if (!body.channel_id || !body.message?.id) return;
    await discordFetch(env, `/channels/${body.channel_id}/messages/${body.message.id}`, "PATCH", { content, components: [] });
  };
  ctx.waitUntil(task()
    .then(() => updateOriginal("Done."))
    .catch(async (e) => {
      console.error("prospector: Discord action failed:", e.message);
      try { await updateOriginal("That action failed."); } catch {}
    }));
  return json(200, { type: 6 });
}

export async function discordSend(env, channelKey, { content, embeds, components } = {}) {
  if (!configured(env)) return null;
  try {
    const cfg = await discordConfig(env);
    const channel_id = cfg.channels?.[channelKey];
    if (!channel_id) return null;
    const send = () => fetch(`${API}/channels/${channel_id}/messages`, { method: "POST", headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ content, embeds, components, allowed_mentions: { parse: [] } }) });
    let res = await send();
    if (res.status === 429) {
      let wait = 0; try { wait = Math.min(30000, Math.max(0, Number((await res.json()).retry_after) * 1000)); } catch {}
      await new Promise((resolve) => setTimeout(resolve, wait));
      res = await send();
    }
    if (!res.ok) { console.error("prospector: Discord send failed:", res.status); return null; }
    return await res.json();
  } catch (e) { console.error("prospector: Discord send failed:", e?.message || "unknown error"); return null; }
}

export async function discordApi(env, path, method = "GET", body) {
  return discordFetch(env, path, method, body);
}

async function discordFetch(env, path, method = "GET", body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`Discord API ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export async function setupDiscord(env, guildId) {
  if (!configured(env) || !/^\d{17,20}$/.test(String(guildId || ""))) return { ok: false, error: "Discord configuration and a valid server ID are required." };
  try {
    const guild = await discordFetch(env, `/guilds/${guildId}`);
    const channels = await discordFetch(env, `/guilds/${guildId}/channels`);
    const me = await discordFetch(env, "/users/@me");
    const categories = {};
    for (const name of CATEGORIES) {
      let found = channels.find((c) => c.type === 4 && c.name === name.toLowerCase());
      if (!found) found = await discordFetch(env, `/guilds/${guildId}/channels`, "POST", { name: name.toLowerCase(), type: 4 });
      categories[name] = found.id;
    }
    const ids = {};
    for (const name of CHANNELS) {
      const category = name === "hq" ? "HQ" : name === "builds" ? "Projects" : "Operations";
      let found = channels.find((c) => c.name === name && c.type === 0);
      if (!found) found = await discordFetch(env, `/guilds/${guildId}/channels`, "POST", { name, type: 0, parent_id: categories[category] });
      ids[name] = found.id;
    }
    let forum = channels.find((c) => c.name === "tasks" && c.type === 15);
    if (!forum) forum = await discordFetch(env, `/guilds/${guildId}/channels`, "POST", { name: "tasks", type: 15, parent_id: categories.Projects, available_tags: ["proposed", "approved", "in-progress", "review", "done"].map((name) => ({ name, moderated: false })) });
    else {
      const tags = ["proposed", "approved", "in-progress", "review", "done"];
      if (tags.some((name) => !(forum.available_tags || []).some((tag) => tag.name === name))) {
        forum = await discordFetch(env, `/channels/${forum.id}`, "PATCH", { parent_id: categories.Projects, available_tags: tags.map((name) => ({ name, moderated: false })) });
      }
    }
    ids.tasks = forum.id;
    const ownerId = guild.owner_id;
    if (!ownerId) throw new Error("Could not identify server owner.");
    await metaSet(env.DB, "discord", JSON.stringify({ guild: String(guildId), admins: [String(ownerId)], bot: me.id, categories, channels: ids }));
    return { ok: true, channels: ids };
  } catch (e) { console.error("prospector: Discord setup failed:", e.message); return { ok: false, error: "Discord setup failed. Check the bot's server access and permissions." }; }
}

export function discordButtons(items) {
  return items?.length ? [{ type: 1, components: items.map(({ id, label, style = 2, url }) => ({ type: url ? 2 : 2, style: url ? 5 : style, label, ...(url ? { url } : { custom_id: id }) })) }] : [];
}
