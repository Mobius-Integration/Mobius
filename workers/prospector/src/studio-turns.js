import { buildStudioSystem, parseStudioReply, postTurn, readBrief, replyAI } from "./studio.js";

const MAX = (v, d, m) => { const n=Number.parseInt(v,10); return Math.max(0,Math.min(m,Number.isFinite(n)?n:d)); };
export async function pcAlive(env) {
  if (env.STUDIO_BRAIN === "cloudflare") return false;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key='studio_pc_seen'").first();
  return !!row?.value && Date.now() - Date.parse(row.value) <= 3 * 60 * 1000;
}
export async function markPcSeen(env) {
  await env.DB.prepare("INSERT INTO meta (key,value) VALUES ('studio_pc_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(new Date().toISOString()).run();
}
export async function queueStudioTurn(env, input, deep = false) {
  await env.DB.prepare("INSERT INTO studio_turns (input,deep,state) VALUES (?,?, 'pending')").bind(String(input).slice(0, 5000), deep ? 1 : 0).run();
}
export async function claimStudioCall(env) {
  const author = "usage:calls";
  const r = await env.DB.prepare("INSERT INTO studio_messages (id,author,content) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM studio_messages WHERE author=? AND created_at >= date('now')) < ?")
    .bind(crypto.randomUUID(), author, "1", author, MAX(env.STUDIO_MAX_CALLS_PER_DAY, 150, 2000)).run();
  return Number(r.meta?.changes || 0) > 0;
}
export async function nextStudioTurn(env) {
  await markPcSeen(env);
  const row = await env.DB.prepare("SELECT id,input,deep FROM studio_turns WHERE state='pending' ORDER BY id LIMIT 1").first();
  if (!row) return null;
  const claim = await env.DB.prepare("UPDATE studio_turns SET state='claimed',claimed_at=datetime('now') WHERE id=? AND state='pending'").bind(row.id).run();
  if (!Number(claim.meta?.changes || 0)) return null;
  if (!(await claimStudioCall(env))) {
    await cloudFallback(env,{...row,state:"claimed"},"Codex reached today's Studio call cap; Cloudflare answered instead.");
    await env.DB.prepare("UPDATE studio_turns SET state='fallback',done_at=datetime('now'),note='Daily call cap' WHERE id=? AND state='claimed'").bind(row.id).run();
    return null;
  }
  const hist = await env.DB.prepare("SELECT author,content FROM studio_messages WHERE author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 30").all();
  const cfgRow = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); let cfg={}; try { cfg=JSON.parse(cfgRow?.value||"{}"); } catch {}
  const history=(hist.results||[]).reverse(); if(history.at(-1)?.content===row.input)history.pop();
  const brief=await readBrief(env);
  return { id: row.id, deep: !!row.deep, system: buildStudioSystem(brief), brief, history, input: row.input, channel: cfg.channels?.["brand-studio"] };
}
async function cloudFallback(env, row, note) {
  const cfgRow = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); let cfg={}; try { cfg=JSON.parse(cfgRow?.value||"{}"); } catch {}
  const channel=cfg.channels?.["brand-studio"]; if (!channel) return;
  const hist=await env.DB.prepare("SELECT author,content FROM studio_messages WHERE author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 30").all();
  const history=(hist.results||[]).reverse(); if(history.at(-1)?.content===row.input)history.pop();
  const result=await replyAI(env,await readBrief(env),history,row.input);
  if (note) result.reply += `\n\n(${note})`;
  await postTurn(env,result,channel);
}
export async function doneStudioTurn(env, id, raw) {
  const parsed=parseStudioReply(raw);
  if (!parsed) return failStudioTurn(env,id,"Codex returned invalid JSON");
  const row=await env.DB.prepare("SELECT id,input,state FROM studio_turns WHERE id=?").bind(Number(id)).first();
  if (!row || row.state !== "claimed") return false;
  const cfg=await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); let c={}; try{c=JSON.parse(cfg?.value||"{}")}catch{}
  const channel=c.channels?.["brand-studio"]; if (!channel) return false;
  await postTurn(env,parsed,channel);
  await env.DB.prepare("UPDATE studio_turns SET state='done',done_at=datetime('now') WHERE id=? AND state='claimed'").bind(id).run(); return true;
}
export async function failStudioTurn(env,id,reason="PC brain unavailable") {
  const row=await env.DB.prepare("SELECT id,input,state FROM studio_turns WHERE id=?").bind(Number(id)).first();
  if (!row || !["claimed","pending"].includes(row.state)) return false;
  await cloudFallback(env,row,`Codex was unavailable; Cloudflare answered instead (${String(reason).slice(0,120)}).`);
  await env.DB.prepare("UPDATE studio_turns SET state='fallback',done_at=datetime('now'),note=? WHERE id=? AND state IN ('claimed','pending')").bind(String(reason).slice(0,250),id).run(); return true;
}
export async function fallbackStudioTurns(env) {
  const rows=await env.DB.prepare("SELECT id,input,state FROM studio_turns WHERE state IN ('pending','claimed') AND created_at < datetime('now','-4 minutes')").all();
  for (const row of rows.results||[]) { try { await failStudioTurn(env,row.id,"Turn exceeded four minutes"); } catch (e) { console.error("prospector: Studio fallback failed:",e?.message||"unknown error"); } }
}
