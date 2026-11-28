import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// OpenAI's strict structured output: every object closed (additionalProperties false) and every property
// required, so open-ended brief updates travel as a JSON string (brief_updates_json) and are parsed here.
const closed = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const schema = closed({
  reply: { type: "string" },
  mockup_html: { type: "string", description: "HTML visual preview, empty when none is needed; maximum 14000 characters." },
  options: { type: "array", items: closed({ label: { type: "string" } }) },
  palette: { type: "array", items: closed({ name: { type: "string" }, hex: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, use: { type: "string" } }) },
  textures: { type: "array", items: closed({ name: { type: "string" }, prompt: { type: "string" } }) },
  brief_updates_json: { type: "string", description: "A JSON object, as a string, with only the brand-brief fields that changed; \"{}\" when nothing changed." },
});
export function buildPrompt(turn) {
  return `${turn.system}\n\nWhen Mario asks to see, compare or choose anything visual (fonts, logo, colours, layouts, textures in use), or you offer visual options as buttons, mockup_html MUST show them side by side, labelled exactly like the buttons, at 1200px wide. Use real fonts through Google Fonts @import, the real name Mobius Integration, and the Beach Pop brand: pink #D6336C, teal #00A0A4, sunshine #FFD447, ink #1B1B3A, pastel tints #FFE7F0 / #DDF7F7 / #FFF4C2, Baloo 2 headings, DM Sans body, and Mario's colorful logo via <mobius-mark></mobius-mark>. Never say a sample is shown unless mockup_html contains it. Logo variations must use <mobius-mark style="..." class="..."/> for Mario's real strip; never draw a new logo shape.\n\nBrand brief:\n${JSON.stringify(turn.brief)}\n\nConversation history:\n${(turn.history || []).map(m => `${m.author === "bot:studio" ? "Studio" : "Mario"}: ${m.content}`).join("\n")}\n\nNew input:\n${turn.input}\n\nReturn only the required JSON object. Put brief updates in brief_updates_json as a JSON-encoded string ("{}" if none).`;
}
// Turns Codex's schema output back into the shape the Worker validates.
export function toStudioResult(raw) {
  let updates = {};
  try { const u = JSON.parse(raw && raw.brief_updates_json || "{}"); if (u && typeof u === "object" && !Array.isArray(u)) updates = u; } catch { /* keep {} */ }
  const { brief_updates_json, ...rest } = raw || {};
  return { ...rest, brief_updates: updates };
}
function runCodex(prompt, turn, dir, spawn = nodeSpawn) {
  const schemaFile=join(dir,"schema.json"), outFile=join(dir,"out.json");
  return new Promise((resolve,reject)=>{
    const child=spawn("codex",["exec","--skip-git-repo-check","-s","read-only","-C",dir,"--output-schema",schemaFile,"-o",outFile,"-c",`model_reasoning_effort=${turn.deep?"high":"medium"}`,"-"],{stdio:["pipe","ignore","pipe"],
      // On Windows, npm installs codex as a .cmd/.ps1 wrapper, which Node can only start through the shell.
      // The arguments are fixed flags and temp-folder paths (no spaces or shell characters).
      shell:process.platform==="win32"});
    let stderr="", settled=false;
    const finish=(err)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve();};
    child.stderr?.on("data",x=>{stderr+=x.toString();}); child.on("error",e=>finish(e)); child.on("close",code=>finish(code===0?null:new Error(/limit|rate/i.test(stderr)?"Codex usage limit":"Codex failed")));
    const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new Error("Codex timed out"));},150000);
    child.stdin.end(prompt);
  });
}
export async function handleTurn(turn,{spawn=nodeSpawn,fetchImpl=fetch,baseUrl}) {
  const start=Date.now();
  let dir;
  try {
    dir=await mkdtemp(join(tmpdir(),"studio-codex-"));
    const custom=typeof turn.prompt==="string"&&turn.schema&&typeof turn.schema==="object";
    await writeFile(join(dir,"schema.json"),JSON.stringify(custom?turn.schema:schema));
    await runCodex(custom?turn.prompt:buildPrompt(turn),turn,dir,spawn);
    const parsed=JSON.parse(await readFile(join(dir,"out.json"),"utf8"));
    const result=custom?parsed:toStudioResult(parsed);
    if(custom){
      const response=await fetchImpl(`${baseUrl}/studio/done`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:turn.id,result})});
      if(!response.ok)throw new Error("Office completion rejected");
      return {ok:true,id:turn.id,ms:Date.now()-start};
    }
    if (!result || typeof result.reply!=="string" || typeof result.mockup_html!=="string" || !Array.isArray(result.options)||!Array.isArray(result.palette)||!Array.isArray(result.textures)||!result.brief_updates||typeof result.brief_updates!=="object"||Array.isArray(result.brief_updates)) throw new Error("Invalid Codex JSON");
    const response=await fetchImpl(`${baseUrl}/studio/done`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:turn.id,result})});
    if(!response.ok) throw new Error("Studio completion rejected");
    return {ok:true,id:turn.id,ms:Date.now()-start};
  } catch(e) {
    const reason=String(e?.message||"Codex failed").slice(0,160);
    try { await fetchImpl(`${baseUrl}/studio/fail`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:turn.id,reason})}); } catch {}
    return {ok:false,id:turn.id,ms:Date.now()-start,reason,backoff:e instanceof TypeError};
  } finally {
    if (dir) await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
async function poll(baseUrl, opts={}) {
  const r=await (opts.fetchImpl||fetch)(`${baseUrl}/studio/next`);
  if(!r.ok) throw new Error("Studio poll failed");
  const data=await r.json();
  // The Worker sends a fresh board link when ours is close to expiring: save it (see main).
  if(data.fresh && opts.onFresh) await opts.onFresh(String(data.fresh));
  if(!data.turn)return null;
  return handleTurn(data.turn,{...opts,baseUrl});
}
export async function main({once=process.argv.includes("--once"),fetchImpl=fetch,spawn=nodeSpawn}={}) {
  const file=process.env.STUDIO_BOARD_URL_FILE;
  if(!file) throw new Error("Set STUDIO_BOARD_URL_FILE to a file containing the signed board URL.");
  let baseUrl=(await readFile(file,"utf8")).trim().replace(/\/$/,"");
  // Only ever accept a board link on our own domain (never print it).
  const onFresh=async (u)=>{ if(/^https:\/\/mobiusintegration\.com\/ops\/b\/\d{9,11}\/[A-Za-z0-9_-]{43}$/.test(u)) { await writeFile(file,u+"\n"); baseUrl=u; } };
  const log=join(HERE,"studio-pc.log");
  do {
    try { const result=await poll(baseUrl,{fetchImpl,spawn,onFresh}); if(result) { await appendFile(log,`${new Date().toISOString()} turn ${result.id} ${result.ms}ms ${result.ok?"ok":"fail"}\n`); if(result.backoff&&!once) await new Promise(r=>setTimeout(r,30000)); } }
    catch { if(once) throw new Error("Studio poll failed"); await new Promise(r=>setTimeout(r,30000)); }
    if(once)return;
    await new Promise(r=>setTimeout(r,10000));
  } while(true);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(()=>{process.exitCode=1;});
