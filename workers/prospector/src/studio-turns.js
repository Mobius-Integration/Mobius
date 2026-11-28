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
  const latest=await env.DB.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM studio_messages").first();
  await env.DB.prepare("INSERT INTO studio_turns (input,deep,state,kind,source_seq) VALUES (?,?, 'pending','studio',?)").bind(String(input).slice(0, 5000), deep ? 1 : 0, Number(latest?.seq||0)).run();
}
export async function claimStudioCall(env) {
  const author = "usage:calls";
  const r = await env.DB.prepare("INSERT INTO studio_messages (id,author,content) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM studio_messages WHERE author=? AND created_at >= date('now')) < ?")
    .bind(crypto.randomUUID(), author, "1", author, MAX(env.STUDIO_MAX_CALLS_PER_DAY, 150, 2000)).run();
  return Number(r.meta?.changes || 0) > 0;
}
export async function nextStudioTurn(env) {
  await markPcSeen(env);
  const row = await env.DB.prepare("SELECT id,input,deep,kind,run_id,role,step,prompt,schema_json FROM studio_turns WHERE state='pending' ORDER BY id LIMIT 1").first();
  if (!row) return null;
  const claim = await env.DB.prepare("UPDATE studio_turns SET state='claimed',claimed_at=datetime('now') WHERE id=? AND state='pending'").bind(row.id).run();
  if (!Number(claim.meta?.changes || 0)) return null;
  if (!(await claimStudioCall(env))) {
    if(row.kind==="office") await cloudOfficeFallback(env,{...row,state:"claimed"},"Codex reached today's Studio call cap; Cloudflare answered instead.");
    else await cloudFallback(env,{...row,state:"claimed"},"Codex reached today's Studio call cap; Cloudflare answered instead.");
    await env.DB.prepare("UPDATE studio_turns SET state='fallback',done_at=datetime('now'),note='Daily call cap' WHERE id=? AND state='claimed'").bind(row.id).run();
    return null;
  }
  if(row.kind==="office")return {id:row.id,kind:"office",run_id:row.run_id,role:row.role,step:row.step,prompt:row.prompt,schema:JSON.parse(row.schema_json||"{}"),input:row.input||""};
  const hist = await env.DB.prepare("SELECT author,content FROM studio_messages WHERE author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 30").all();
  const cfgRow = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); let cfg={}; try { cfg=JSON.parse(cfgRow?.value||"{}"); } catch {}
  const history=(hist.results||[]).reverse(); if(history.at(-1)?.content===row.input)history.pop();
  const brief=await readBrief(env);
  return { id: row.id, deep: !!row.deep, system: buildStudioSystem(brief), brief, history, input: row.input, channel: cfg.channels?.["brand-studio"] };
}
async function cloudFallback(env, row, note) {
  const cfgRow = await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); let cfg={}; try { cfg=JSON.parse(cfgRow?.value||"{}"); } catch {}
  const channel=cfg.channels?.["brand-studio"]; if (!channel) return;
  const newer=await env.DB.prepare("SELECT seq,author,content FROM studio_messages WHERE seq>? AND author NOT LIKE 'bot:%' AND author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 1").bind(Number(row.source_seq||0)).first();
  if(newer){await env.DB.prepare("UPDATE studio_turns SET state='done',done_at=datetime('now'),note='stale' WHERE id=? AND state IN ('claimed','pending')").bind(row.id).run();const pending=await env.DB.prepare("SELECT id FROM studio_turns WHERE kind='studio' AND id<>? AND state IN ('pending','claimed') ORDER BY id LIMIT 1").bind(row.id).first();if(!pending)await queueStudioTurn(env,newer.content,false);return;}
  const hist=await env.DB.prepare("SELECT author,content FROM studio_messages WHERE author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 30").all();
  const history=(hist.results||[]).reverse(); if(history.at(-1)?.content===row.input)history.pop();
  const result=await replyAI(env,await readBrief(env),history,row.input);
  if (note) result.reply += `\n\n(${note})`;
  await postTurn(env,result,channel);
}
export async function doneStudioTurn(env, id, raw) {
  const office=await env.DB.prepare("SELECT id,kind,run_id,role,step FROM studio_turns WHERE id=?").bind(Number(id)).first();
  if(office?.kind==="office"){
    const {officeTurnResult}=await import("./office.js");const ok=await officeTurnResult(env,office,raw,false);
    if(ok)await env.DB.prepare("UPDATE studio_turns SET state='done',done_at=datetime('now') WHERE id=? AND state='claimed'").bind(id).run();return ok;
  }
  const parsed=parseStudioReply(raw);
  if (!parsed) return failStudioTurn(env,id,"Codex returned invalid JSON");
  const row=await env.DB.prepare("SELECT id,input,state,source_seq FROM studio_turns WHERE id=?").bind(Number(id)).first();
  if (!row || row.state !== "claimed") return false;
  const cfg=await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first(); let c={}; try{c=JSON.parse(cfg?.value||"{}")}catch{}
  const channel=c.channels?.["brand-studio"]; if (!channel) return false;
  const newer=await env.DB.prepare("SELECT seq,author,content FROM studio_messages WHERE seq>? AND author NOT LIKE 'bot:%' AND author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 1").bind(Number(row.source_seq||0)).first();
  if(newer){ await env.DB.prepare("UPDATE studio_turns SET state='done',done_at=datetime('now'),note='stale' WHERE id=? AND state='claimed'").bind(id).run(); const pending=await env.DB.prepare("SELECT id FROM studio_turns WHERE kind='studio' AND id<>? AND state IN ('pending','claimed') ORDER BY id LIMIT 1").bind(id).first(); if(!pending)await queueStudioTurn(env,newer.content,false); return true; }
  await postTurn(env,parsed,channel);
  await env.DB.prepare("UPDATE studio_turns SET state='done',done_at=datetime('now') WHERE id=? AND state='claimed'").bind(id).run(); return true;
}
export async function failStudioTurn(env,id,reason="PC brain unavailable") {
  const row=await env.DB.prepare("SELECT id,input,state,source_seq FROM studio_turns WHERE id=?").bind(Number(id)).first();
  if (!row || !["claimed","pending"].includes(row.state)) return false;
  const full=await env.DB.prepare("SELECT id,input,state,kind,run_id,role,step,prompt,schema_json,source_seq FROM studio_turns WHERE id=?").bind(Number(id)).first();
  if(full?.kind==="office"){
    await env.DB.prepare("UPDATE studio_turns SET state='claimed' WHERE id=? AND state='pending'").bind(id).run();
    await cloudOfficeFallback(env,full,reason);
    await env.DB.prepare("UPDATE studio_turns SET state='fallback',done_at=datetime('now'),note=? WHERE id=?").bind(String(reason).slice(0,250),id).run();return true;
  }
  await cloudFallback(env,row,`Codex was unavailable; Cloudflare answered instead (${String(reason).slice(0,120)}).`);
  await env.DB.prepare("UPDATE studio_turns SET state='fallback',done_at=datetime('now'),note=? WHERE id=? AND state IN ('claimed','pending')").bind(String(reason).slice(0,250),id).run(); return true;
}
export async function fallbackStudioTurns(env) {
  const rows=await env.DB.prepare("SELECT id,input,state,kind,run_id,role,step,prompt,schema_json,source_seq FROM studio_turns WHERE state IN ('pending','claimed') AND created_at < datetime('now','-4 minutes')").all();
  for (const row of rows.results||[]) { try { await failStudioTurn(env,row.id,"Turn exceeded four minutes"); } catch (e) { console.error("prospector: Studio fallback failed:",e?.message||"unknown error"); } }
}
async function cloudOfficeFallback(env,row,reason){
 const {modelText,runModel}=await import("./studio.js");const {strictOfficeResult,officeTurnResult}=await import("./office.js");
 const messages=[{role:"system",content:"Return only JSON matching the supplied schema exactly."},{role:"user",content:`${row.prompt}

Schema: ${row.schema_json}`}];
 let parsed=null;
 for(const model of [env.STUDIO_MODEL||"@cf/openai/gpt-oss-120b","@cf/meta/llama-3.3-70b-instruct-fp8-fast"]){let output="";try{output=modelText(await runModel(env,model,messages));}catch{}parsed=strictOfficeResult(String(output).replace(/^```(?:json)?s*|s*```$/g,""),row.step);if(parsed)break;}
 if(!parsed){parsed=row.step==="chief:open"?{message:"Office backup could not produce a valid opening; proceeding with available data.",notebook:""}:row.step==="chief:wrap"?{summary:"Standup completed with backup model fallback.\nNo verified proposal produced.\nReview the run thread for evidence.",thread_title:"Backup summary",proposals:[],notebook:""}:{message:"Backup model could not produce a validated result; no claims or proposals added.",proposals_json:"[]",notebook:"",texture_prompts:[],mockup_html:"",piece_kind:"none",piece_title:"",piece_text:""};}
 await officeTurnResult(env,row,parsed,true);
}
