import test from "node:test";
import assert from "node:assert/strict";
import { officeSlot, strictOfficeResult, escapeMentions } from "../src/office.js";

test("office slots follow New York wall time across daylight saving",()=>{
 assert.equal(officeSlot(new Date("2026-01-15T14:00:00Z")),"2026-01-15 09");
 assert.equal(officeSlot(new Date("2026-07-15T13:00:00Z")),"2026-07-15 09");
 assert.equal(officeSlot(new Date("2026-03-08T13:00:00Z")),"2026-03-08 09");
 assert.equal(officeSlot(new Date("2026-11-01T14:00:00Z")),"2026-11-01 09");
 assert.equal(officeSlot(new Date("2026-11-01T13:00:00Z")),null);
});

test("office output validation is closed, bounded, and escapes mass mentions",()=>{
 const open={message:"Agenda",notebook:"Next"};
 assert.deepEqual(strictOfficeResult(open,"chief:open"),open);
 assert.equal(strictOfficeResult({...open,extra:"no"},"chief:open"),null);
 const work={message:"Evidence",proposals_json:'[{"title":"Try","why":"Why","effort":"Small"}]',notebook:"Next",texture_prompts:[]};
 assert.equal(strictOfficeResult(work,"growth:discuss").message,"Evidence");
 assert.equal(strictOfficeResult({...work,extra:true},"growth:work"),null);
 assert.equal(strictOfficeResult({...work,message:"x".repeat(700)},"growth:discuss").message.length,600);
 assert.equal(escapeMentions("@everyone @here"),"@\u200beveryone @\u200bhere");
});
