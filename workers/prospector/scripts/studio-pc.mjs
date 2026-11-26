import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const schema = { type: "object", additionalProperties: false, required: ["reply", "options", "palette", "textures", "brief_updates"], properties: { reply: { type: "string" }, options: { type: "array", items: { type: "object", required: ["label"], properties: { label: { type: "string" } } } }, palette: { type: "array", items: { type: "object", required: ["name", "hex", "use"], properties: { name: { type: "string" }, hex: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, use: { type: "string" } } } }, textures: { type: "array", items: { type: "object", required: ["name", "prompt"], properties: { name: { type: "string" }, prompt: { type: "string" } } } }, brief_updates: { type: "object" } } };
export function buildPrompt(turn) {
  return `${turn.system}\n\nBrand brief:\n${JSON.stringify(turn.brief)}\n\nConversation history:\n${(turn.history || []).map(m => `${m.author === "bot:studio" ? "Studio" : "Mario"}: ${m.content}`).join("\n")}\n\nNew input:\n${turn.input}\n\nReturn only the required JSON object.`;
}
function runCodex(prompt, turn, dir, spawn = nodeSpawn) {
  const schemaFile=join(dir,"schema.json"), outFile=join(dir,"out.json");
  return new Promise((resolve,reject)=>{
    const child=spawn("codex",["exec","--skip-git-repo-check","-s","read-only","-C",dir,"--output-schema",schemaFile,"-o",outFile,"-c",`model_reasoning_effort=${turn.deep?"high":"medium"}`,"-"],{stdio:["pipe","ignore","pipe"]});
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
    await writeFile(join(dir,"schema.json"),JSON.stringify(schema));
    await runCodex(buildPrompt(turn),turn,dir,spawn);
    const result=JSON.parse(await readFile(join(dir,"out.json"),"utf8"));
    if (!result || typeof result.reply!=="string" || !Array.isArray(result.options)||!Array.isArray(result.palette)||!Array.isArray(result.textures)||!result.brief_updates||typeof result.brief_updates!=="object"||Array.isArray(result.brief_updates)) throw new Error("Invalid Codex JSON");
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
