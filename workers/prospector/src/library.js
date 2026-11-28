import { callAgent } from "./agent.js";
import { botKey, discordConfig } from "./discord.js";

const KINDS = new Set(["linkedin_post","email_draft","walkin_script","reply_template","subject_lines","design","other"]);
export async function saveLibrary(env, {kind,title,body,source,sourceRef}) {
  if (!KINDS.has(kind) || !["standup","builder"].includes(source)) throw new Error("Invalid piece.");
  const r = await env.DB.prepare("INSERT INTO library(kind,title,body,source,source_ref) VALUES(?,?,?,?,?)").bind(kind,String(title||"Untitled").slice(0,120),String(body||"").slice(0,5000),source,String(sourceRef)).run();
  return Number(r.meta?.last_row_id);
}
async function config(env){const r=await env.DB.prepare("SELECT value FROM meta WHERE key='discord'").first();try{return JSON.parse(r?.value||"{}")}catch{return {}}}
async function send(env,channel,payload){const token=await botKey(env);if(!token)throw new Error("Discord bot is not configured.");const r=await fetch(`https://discord.com/api/v10/channels/${channel}/messages`,{method:"POST",headers:{Authorization:`Bot ${token}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});if(!r.ok)throw new Error(`Discord post failed (${r.status}).`);return r.json()}
export async function addUseButtons(env,channel,messageId,id){const token=await botKey(env);if(!token)return null;const r=await fetch(`https://discord.com/api/v10/channels/${channel}/messages`,{method:"POST",headers:{Authorization:`Bot ${token}`,"Content-Type":"application/json"},body:JSON.stringify({content:"Ready to use?",message_reference:{message_id:String(messageId)},components:[{type:1,components:[{type:2,style:3,label:"Use it",custom_id:`office:use:${id}`},{type:2,style:2,label:"Skip",custom_id:`office:skip:${id}`}]}],allowed_mentions:{parse:[]}})});if(!r.ok)throw new Error(`Discord button post failed (${r.status}).`);return r.json()}
export async function usePiece(env,id,source="standup",deps={}){
 const piece=source==="standup"?await env.DB.prepare("SELECT piece_kind AS kind,piece_title AS title,piece_text AS body,library_id,use_state FROM office_run_messages WHERE id=?").bind(id).first():await env.DB.prepare("SELECT build_kind AS kind,title,build_note AS body,build_state AS use_state FROM office_proposals WHERE id=?").bind(id).first();
 if(!piece)throw new Error("Piece not found."); if(source==="standup"&&piece.library_id)return {libraryId:piece.library_id,message:"Already saved in the library."};
 const kind=source==="builder"?(piece.kind==="content"?"other":piece.kind):piece.kind;
 const libraryId=await saveLibrary(env,{kind,title:piece.title,body:piece.body,source,sourceRef:String(id)});
 await env.DB.prepare("UPDATE library SET state='ready' WHERE id=?").bind(libraryId).run();
 if(source==="standup")await env.DB.prepare("UPDATE office_run_messages SET library_id=?,use_state='used' WHERE id=?").bind(libraryId,id);
 let message="Saved in your library.";
 if(kind==="email_draft"||kind==="reply_template"){
  const m=String(piece.body||"").match(/^\s*(?:to|recipient):\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*$/im), address=m?.[1]||"";
  const subject=String(piece.title||"").replace(/^subject:\s*/i,"").slice(0,200);
  const st=await env.DB.prepare("SELECT value FROM meta WHERE key='agent_url'").first();
  const token=await env.DB.prepare("SELECT value FROM meta WHERE key='agent_token'").first();
  try { await (deps.callAgent||callAgent)({url:st?.value,token:token?.value},"draft",{to:address,subject,body:piece.body}); message="Draft saved in Gmail."; }
  catch(e){message=`Saved in the library. Gmail draft unavailable: ${String(e?.message||e).slice(0,180)}`;}
 }
 if(kind==="linkedin_post"){
  try{const meta=await env.DB.prepare("SELECT value FROM meta WHERE key='office_evening_summary_message'").first(),c=await config(env);if(meta?.value&&c.channels?.hq){const token=await botKey(env);const r=await fetch(`https://discord.com/api/v10/channels/${c.channels.hq}/messages/${meta.value}`,{headers:{Authorization:`Bot ${token}`}});if(r.ok){const old=await r.json(),line=String(piece.body||"").split(/\r?\n/)[0];const content=`${old.content||""}\n\nReady to post\n**${piece.title}**\n${line}`.slice(0,1900);const components=[...(old.components||[]),{type:1,components:[{type:2,style:3,label:"Mark posted",custom_id:`library:used:${libraryId}`}]}].slice(0,5);await fetch(`https://discord.com/api/v10/channels/${c.channels.hq}/messages/${meta.value}`,{method:"PATCH",headers:{Authorization:`Bot ${token}`,"Content-Type":"application/json"},body:JSON.stringify({content,components})});}}}catch{}
 }
 if(kind==="walkin_script"||kind==="reply_template")message+=" Printable kit: available on the protected board.";
 return {libraryId,message};
}
export async function postLibrarySummary(env,channel){const rows=(await env.DB.prepare("SELECT id,title,body FROM library WHERE kind='linkedin_post' AND state='ready' ORDER BY id DESC LIMIT 10").all()).results||[];if(!rows.length)return null;const content="Ready to post:\n"+rows.map(x=>`**${x.title}**\n${String(x.body||"").split(/\\r?\\n/)[0]}`).join("\n\n").slice(0,1700);const token=await botKey(env);if(!token)return null;const components=rows.slice(0,5).map(x=>({type:1,components:[{type:2,style:3,label:"Mark posted",custom_id:`library:used:${x.id}`}]}));return send(env,channel,{content,components,allowed_mentions:{parse:[]}})}
export async function markLibraryUsed(env,id){await env.DB.prepare("UPDATE library SET state='used',used_at=datetime('now') WHERE id=? AND state='ready'").bind(id).run()}
export async function libraryKit(env){const rows=(await env.DB.prepare("SELECT kind,title,body FROM library WHERE state='ready' AND kind IN ('walkin_script','reply_template') ORDER BY kind,title,id").all()).results||[];return rows}
