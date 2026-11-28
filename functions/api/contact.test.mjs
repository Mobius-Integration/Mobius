import test from "node:test";
import assert from "node:assert/strict";
import { classifyPitch, isBotTrap } from "./contact.js";

const owner = {
  name: "Local owner",
  email: "owner@example.com",
  business: "Bay Area Salon",
  site_url: "https://bayareasalon.com",
  message: "I'd like a free write-up of my booking page.",
};

test("bot traps catch a filled honeypot and submissions under three seconds", () => {
  assert.equal(isBotTrap({ company_site: "https://spam.example" }, 10_000), true);
  assert.equal(isBotTrap({ started_at: "8001" }, 10_000), true);
  assert.equal(isBotTrap({ started_at: "7000" }, 10_000), false);
  assert.equal(isBotTrap({ started_at: "11000" }, 10_000), false);
  assert.equal(isBotTrap({ started_at: "" }, 10_000), false);
});

test("flags look-alike and own-domain email addresses", () => {
  assert.equal(classifyPitch({ ...owner, email: "rep@search-mobiusintegration.com" }), true);
  assert.equal(classifyPitch({ ...owner, email: "owner@mobiusintegration.com" }), true);
});

test("flags sales offers referring to Mobius or the recipient's site", () => {
  assert.equal(classifyPitch({ ...owner, message: "SEO ranking for mobiusintegration.com" }), true);
  assert.equal(classifyPitch({ ...owner, message: "I can help your website get more traffic" }), true);
  assert.equal(classifyPitch({ ...owner, message: "We help businesses with marketing services for your site. Proposal attached." }), true);
});

test("flags a big non-local website and accepts a local owner's write-up request", () => {
  assert.equal(classifyPitch({ ...owner, site_url: "www.bbc.com" }), true);
  assert.equal(classifyPitch(owner), false);
});
