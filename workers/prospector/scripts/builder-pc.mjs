import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, appendFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE=dirname(fileURLToPath(import.meta.url));
export const dailyCap=(value)=>Math.max(1,Math.min(20,Number(value)||3));
export const dailyCount=(logText,day)=>String(logText||"").split(/\r?\n/).filter(line=>line.startsWith(day)&&/ task \d+ /.test(line)).length;
const closed=(properties)=>({type:"object",additionalProperties:false,required:Object.keys(properties),properties});
export const schema=closed({kind:{type:"string",enum:["decision","content","code"]},summary:{type:"string"},content:{type:"string"},brief:{type:"string"}});
const run=(cmd,args,opts={})=>new Promise((resolve,reject)=>{const c=(opts.spawn||nodeSpawn)(cmd,args,{stdio:["pipe","pipe","pipe"],...(opts.spawn?{}:{shell:process.platform==="win32"&&cmd==="codex"})});let out="",err="";c.stdout?.on("data",x=>out+=x);c.stderr?.on("data",x=>err+=x);c.on("error",reject);c.on("close",code=>code===0?resolve(out):reject(new Error(err.slice(-300)||`${cmd} failed`)));if(opts.input)c.stdin.end(opts.input);else c.stdin.end();});
export async function classifyTask(task,{spawn=nodeSpawn,workDir=process.cwd()}={}){
 const d=await mkdtemp(join(tmpdir(),"builder-classify-")), sf=join(d,"schema.json"),of=join(d,"result.json");
 try{await writeFile(sf,JSON.stringify(schema));const prompt=`Classify this approved Mobius task. Return the exact schema. Use decision for a recommendation resolved in a sentence, content for a draft, code only when repo code changes are needed. For code, write a complete Codex job brief in brief, including task requirements and these hard rules: no deploys or publishing, never invent clients or claims, preserve accessibility, and tests must pass. Never include credentials.\nTask: ${JSON.stringify(task)}`;
 await run("codex",["exec","--skip-git-repo-check","-s","read-only","-C",workDir,"--output-schema",sf,"-o",of,"-"],{spawn,input:prompt});const x=JSON.parse(await readFile(of,"utf8"));if(!x||!schema.required.every(k=>typeof x[k]==="string")||!schema.properties.kind.enum.includes(x.kind)||!x.summary.trim()||(x.kind==="content"&&!x.content.trim())||(x.kind==="code"&&!x.brief.trim()))throw new Error("Invalid classifier output");return x;
 }finally{await import("node:fs/promises").then(fs=>fs.rm(d,{recursive:true,force:true}));}
}
async function update(base,fetchImpl,id,state,kind,note,branch){const r=await fetchImpl(`${base}/builder/update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,state,kind,note,...branch?{branch}:{}})});if(!r.ok)throw new Error("Builder update rejected");}
export async function dispatchTask(task,{baseUrl,fetchImpl=fetch,spawn=nodeSpawn,workRoot="D:/Mobius-builds",briefRoot="D:/Mobius/_planning/agents/briefs",workDir=process.cwd()}={}){
 let kind="code";try{await update(baseUrl,fetchImpl,task.id,"classifying","decision","Classifying this approved task.");const x=await classifyTask(task,{spawn,workDir});kind=x.kind;
  if(x.kind==="decision"){await update(baseUrl,fetchImpl,task.id,"done","decision",`${x.summary}\n${x.content}`.slice(0,1500));return {kind:x.kind,state:"done"};}
  if(x.kind==="content"){await update(baseUrl,fetchImpl,task.id,"done","content",(x.content||x.summary).slice(0,1500));return {kind:x.kind,state:"done"};}
  const id=String(task.id);if(!/^\d{1,20}$/.test(id))throw new Error("Invalid task id");const wt=join(workRoot,`task-${id}`),branch=`build/task-${id}`;
  try{await access(wt);throw new Error("Worktree already exists");}catch(e){if(e.message==="Worktree already exists")throw e;}
  await mkdir(briefRoot,{recursive:true});const brief=join(briefRoot,`task-${id}.md`);await writeFile(brief,`# Approved task ${id}: ${task.title}\n\n${x.brief}\n\nHard rules: never push, deploy, publish, merge, or run wrangler. Never invent clients, testimonials, stats, claims, or guarantees. Preserve accessibility. All relevant tests must pass.\n`);
  await run("git",["worktree","add","-b",branch,wt,"office"],{spawn});await update(baseUrl,fetchImpl,task.id,"building","code","Worktree created. Running the approved code brief.");
  const output=await run("C:/Program Files/Git/bin/bash.exe",["D:/Mobius/_planning/agents/run-codex.sh",`task-${id}`,`/d/Mobius-builds/task-${id}`,`/d/Mobius/_planning/agents/briefs/task-${id}.md`,"cd workers/prospector && npm test 2>&1 | grep -E '^# (pass|fail)'"],{spawn});
  await update(baseUrl,fetchImpl,task.id,"ready_for_review","code",output.slice(-1450),branch);return {kind:"code",state:"ready_for_review",branch};
 }catch(e){const reason=String(e?.message||"Builder failed").replace(/[\u0000-\u001f]/g," ").slice(0,250);try{await update(baseUrl,fetchImpl,task.id,"failed",kind,reason);}catch{}return {state:"failed",kind,reason};}
}
export async function pollOnce(opts){const r=await opts.fetchImpl(`${opts.baseUrl}/builder/next`);if(!r.ok)throw new Error("Builder poll failed");const data=await r.json();if(data.fresh&&opts.onFresh)await opts.onFresh(String(data.fresh));if(!data.task)return null;const result=await dispatchTask(data.task,opts);await appendFile(opts.log,`${new Date().toISOString()} task ${data.task.id} ${result.state}${result.kind?` ${result.kind}`:""}\n`);return result;}
export async function main({once=process.argv.includes("--once"),fetchImpl=fetch,spawn=nodeSpawn}={}){const file=process.env.BUILDER_BOARD_URL_FILE;if(!file)throw new Error("Set BUILDER_BOARD_URL_FILE to a file containing the signed board URL.");let baseUrl=(await readFile(file,"utf8")).trim().replace(/\/$/,"");const onFresh=async u=>{if(/^https:\/\/mobiusintegration\.com\/ops\/b\/\d{9,11}\/[A-Za-z0-9_-]{43}$/.test(u)){await writeFile(file,u+"\n");baseUrl=u;}};const log=join(HERE,"builder-pc.log"), cap=dailyCap(process.env.BUILDER_MAX_PER_DAY);let count=0,stamp="";do{const now=new Date().toISOString().slice(0,10);if(now!==stamp){stamp=now;count=dailyCount(await readFile(log,"utf8").catch(()=>""),stamp);}if(count<cap){try{const res=await pollOnce({baseUrl,fetchImpl,spawn,onFresh,log});if(res)count++;}catch(e){if(once)throw e;}}if(once)return;await new Promise(r=>setTimeout(r,120000));}while(true);}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(()=>{process.exitCode=1;});
