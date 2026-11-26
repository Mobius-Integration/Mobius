import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, handleTurn, schema } from "../scripts/studio-pc.mjs";

test("Studio PC builds a complete prompt and matching JSON schema", () => {
  const prompt=buildPrompt({system:"rules",brief:{name:"Mobius"},history:[{author:"bot:studio",content:"Hello"}],input:"Palette?"});
  assert.match(prompt,/rules/); assert.match(prompt,/Brand brief/); assert.match(prompt,/Studio: Hello/); assert.match(prompt,/Palette\?/);
  assert.deepEqual(schema.required,["reply","options","palette","textures","brief_updates"]);
});

test("Studio PC sends valid Codex output to done", async () => {
  const root=await mkdtemp(join(tmpdir(),"studio-pc-test-"));
  try {
    const posted=[];
    const result={reply:"A reply",options:[],palette:[],textures:[],brief_updates:{}};
    const spawn=(cmd,args)=>{assert.equal(cmd,"codex");assert.equal(args[args.length-1],"-");const child=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end(){const out=args[args.indexOf("-o")+1];writeFile(out,JSON.stringify(result)).then(()=>child.emit("close",0));}};child.kill=()=>{};return child;};
    const response=await handleTurn({id:14,deep:true,system:"system",brief:{},history:[],input:"Go"},{spawn,baseUrl:"https://board.test",fetchImpl:async(url,opts)=>{posted.push([url,JSON.parse(opts.body)]);return new Response("{}",{status:200});}});
    assert.equal(response.ok,true);assert.equal(response.id,14);assert.equal(posted[0][0],"https://board.test/studio/done");assert.equal(posted[0][1].result.reply,"A reply");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("Studio PC reports invalid output to fail", async () => {
  const posted=[];
  const spawn=(cmd,args)=>{const child=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end(){writeFile(args[args.indexOf("-o")+1],"not json").then(()=>child.emit("close",0));}};child.kill=()=>{};return child;};
  const result=await handleTurn({id:15,deep:false,system:"",brief:{},history:[],input:"x"},{spawn,baseUrl:"https://board.test",fetchImpl:async(url,opts)=>{posted.push(url);return new Response("{}",{status:200});}});
  assert.equal(result.ok,false);assert.equal(posted[0],"https://board.test/studio/fail");
});
