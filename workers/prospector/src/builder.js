import { botKey } from "./discord.js";
import { readBrief } from "./studio.js";
import { galleryMockup, MOCKUP_MAX } from "./gallery.js";

const STATES = new Set(["classifying", "building", "ready_for_review", "done", "failed"]);
const KINDS = new Set(["decision", "content", "code"]);
const validText = (s, max, required = false) => typeof s === "string" && s.length <= max && (!required || !!s.trim()) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
async function cfg(env) { const r = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); try { return JSON.parse(r?.value || "{}"); } catch { return {}; } }
export async function nextBuilderTask(env) {
  const candidate = await env.DB.prepare("SELECT id FROM office_proposals WHERE build_state='queued' ORDER BY id LIMIT 1").first();
  if (!candidate) return null;
  const claimed = await env.DB.prepare("UPDATE office_proposals SET build_state='claimed',build_updated_at=datetime('now') WHERE id=? AND build_state='queued'").bind(candidate.id).run();
  if (!Number(claimed.meta?.changes || 0)) return null;
  const task = await env.DB.prepare("SELECT id,title,why,owner,thread_id FROM office_proposals WHERE id=?").bind(candidate.id).first();
  // Brand context so visual tasks use the approved palette and fonts instead of guessing.
  let brief = ""; try { brief = JSON.stringify(await readBrief(env)).slice(0, 3000); } catch {}
  return task ? { ...task, context: { brand_brief: brief, palette: "Approved: Gulf Teal #247C78, Mangrove #294B42, Bay Sand #E8D7B7, Sky Haze #DCE9E7" } } : null;
}
async function post(env, channel, content) {
  const token = await botKey(env); if (!token) throw new Error("Discord bot is not configured.");
  const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, { method:"POST", headers:{Authorization:`Bot ${token}`,"Content-Type":"application/json"}, body:JSON.stringify({content:content.slice(0,1900),allowed_mentions:{parse:[]}}) });
  if (!r.ok) throw new Error(`Discord post failed (${r.status}).`);
}
export async function updateBuilderTask(env, body) {
  if (!body || Object.keys(body).some(k=>!(["id","state","kind","note","branch","mockup_html"].includes(k))) || !Number.isSafeInteger(body.id) || body.id < 1 || !STATES.has(body.state) || !KINDS.has(body.kind) || !validText(body.note,1500,true) || (body.mockup_html !== undefined && !validText(body.mockup_html, MOCKUP_MAX)) || (body.branch !== undefined && (!validText(body.branch,120,true) || !/^[A-Za-z0-9._/-]+$/.test(body.branch)))) return false;
  // The PC reports "classifying" before it knows the kind, so only a finished decision counts as one.
  const state=body.state;
  const task = await env.DB.prepare("SELECT title,thread_id FROM office_proposals WHERE id=?").bind(body.id).first(); if (!task) return false;
  const branch=body.branch || null;
  const result=await env.DB.prepare("UPDATE office_proposals SET build_state=?,build_kind=?,build_branch=COALESCE(?,build_branch),build_note=?,build_updated_at=datetime('now') WHERE id=?").bind(state,body.kind,branch,body.note,body.id).run();
  if (!Number(result.meta?.changes || 0)) return false;
  if(body.kind==="decision"&&state==="done") {
    const old=await readBrief(env); const next={...old,decisions:[...(old.decisions||[]),{date:new Date().toISOString().slice(0,10),text:body.note.slice(0,300)}].slice(-100)};
    await env.DB.prepare("UPDATE studio_brief SET brief=?,updated_at=datetime('now') WHERE id=1").bind(JSON.stringify(next)).run();
  }
  const cfgValue=await cfg(env), message=`🛠️ Builder · ${state} · ${body.kind}\n**${task.title}**\n${body.note}`;
  await post(env,task.thread_id,message);
  // #builds gets the milestones (building, ready for review, done, failed), not the "classifying" chatter.
  if(cfgValue.channels?.builds&&["ready_for_review","failed"].includes(state)) await post(env,cfgValue.channels.builds,message);
  // A finished visual is rendered and posted to #gallery, linked back to the task thread.
  if(state==="done"&&body.mockup_html&&body.mockup_html.trim()){const ok=await galleryMockup(env,{role:"builder",job:task.title,html:body.mockup_html,threadId:task.thread_id,guild:cfgValue.guild,label:"From the task"});if(ok){try{await post(env,task.thread_id,"Visual posted in #gallery.");}catch{}}}
  return true;
}
