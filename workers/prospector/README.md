# mobius-prospector

A Cloudflare Worker that finds local Tampa Bay businesses with websites, does one polite read-only check of each home page, and emails the founder a weekly digest of the best prospects with drafted outreach emails.

**Nothing is ever sent to a prospect automatically.** The founder reads the digest, finds the contact route on the prospect's own website, and sends any email himself, one at a time.

## Rules this Worker follows

1. **Mail goes to the founder only.** The single send path is `sendToFounder()` in `src/index.js`. It has no recipient parameter: it always sends to the `FOUNDER_TO` secret and refuses if that is missing, malformed, or doesn't match the message's `To` header.
2. **No email-address harvesting.** It stores only what OpenStreetMap publishes about a business: name, website, phone, city, category. It never scrapes, guesses or stores email addresses of prospects.
3. **Polite, read-only checks.** One GET of the home page plus `/robots.txt` per prospect, short timeouts (3 s and 8 s), an identifying User-Agent (`... MobiusProspector/1.0; +https://mobiusintegration.com`), a 150 KB read cap, redirects only. If the `User-agent: *` group of `robots.txt` has `Disallow: /`, the site is skipped (`robots_skip`). It never submits forms.
4. **Fits the Workers Free plan.** Every handler does a small slice of work and exits (see "Free plan budget").
5. **Untrusted input.** Website HTML and OpenStreetMap text are escaped in HTML output, fenced as data in AI prompts, and AI drafts are rejected (replaced by a plain template) if they use forbidden words.
6. **No secrets in the repo.** The founder's address is the secret `FOUNDER_TO`; the optional postal address for the email footer is the secret `MAILING_ADDRESS`.

## How it works

**The harvest runs on the founder's PC, not in the cloud.** Public Overpass servers answer Cloudflare's network with HTTP 521 or time out (seen 2026-11-15 on overpass-api.de, its lz4./z. aliases and private.coffee), but answer a home connection normally. `node scripts/harvest-local.mjs` (from this folder) runs this Worker's own code with `wrangler dev`, with the D1 binding pointed at the live database and `HARVEST_HERE="true"`. It plans the harvest, then harvests one tile per trigger until the queue is empty. That is about 6 Overpass queries and a few minutes; monthly is plenty. The deployed Worker has no `HARVEST_HERE`, so it never queries Overpass.

| Trigger | What it does |
| --- | --- |
| Plan (`0 11 * * MON`, local harvest only) | No Overpass query. Resets every prospect's `sightings` to 0 and queues 6 map tiles (`BBOX` split into a 2 x 3 grid) in `meta['harvest_queue']`. |
| `*/15 * * * *` | **Local harvest only, while tiles are queued: harvest ONE tile.** One Overpass query for that tile, as CSV. It falls back to the next of three endpoints after 30 s and does no checks this run. A failed tile goes to the end of the queue with an attempt counter and is dropped (and logged) after 3 failed attempts. Drops social/aggregator links, chains and big national names, maps each to an audience id, and upserts into D1 (`src/overpass.js`). **Otherwise, in the cloud: check batch.** Takes up to `CHECKS_PER_RUN` new prospects, checks `robots.txt`, runs `checkSite()` from `../shared/site-check.js` (with the HTTP fallback below), and stores the result and an opportunity score 0-100 (`src/score.js`). Idle runs cost two cheap queries. |
| `0 13 * * TUE` | **Digest.** Picks the top `DIGEST_SIZE` checked prospects by score and drafts an outreach email for each with Workers AI (Gemma 4, then Llama 3.3 as fallback, then a plain template). Appends the required footer in code and emails one digest to the founder (`src/digest.js`). |

The digest email has `Reply-To` set to `OPS_ADDRESS`; an Email Routing rule sends that address to this Worker's `email` handler, so the founder can reply with commands.

### Chain filter across tiles

In each tile, a domain shared by 3 or more OpenStreetMap objects is skipped, and the denylist applies. Each upsert adds the domain's count in that tile to `prospects.sightings` (reset when a harvest is planned), so a domain that adds up to 3 or more across tiles is a chain: the check batch and the digest only consider rows with `sightings < 3`. Known gaps: an object that spans a tile edge can be counted in both tiles, and a chain skipped in one tile (3+ there) but seen once in another is still pitched from the second.

### HTTP-only sites

The stored URL is `https://`. If that GET fails with a connection or TLS error (not an HTTP status, not a timeout), the check makes one more GET to `http://`. If it works, the check is recorded with `https = 0`, so "doesn't load over HTTPS" is a real finding instead of the site looking closed. The fallback is the opt-in `httpFallback` option of `checkSite()`; lead-alert opts in too.

### Commands (reply to the digest, one per line)

| Command | Effect |
| --- | --- |
| `SENT <domain>` | Mark the outreach and prospect as sent |
| `SKIP <domain>` | Don't pitch this one |
| `STOP <domain-or-email>` | Add to the suppression list (lowercase) and mark a matching prospect suppressed. For an email address, a prospect on that address's domain is suppressed too |
| `MORE` | Build and send another digest now with the next `DIGEST_SIZE` prospects |
| `STATUS` | Reply with counts per status and the last 5 runs |

Only the founder's address is accepted (anything else is rejected with `Not accepted`). Only the lines before the quoted reply are read, so commands inside quoted text are ignored. The Worker answers with a short confirmation to the founder listing what changed and any lines it didn't understand.

### Score

Starts at 10. Adds: no HTTPS +15, no mobile viewport +15, images without alt +5 per 5 (max +15), unlabeled form fields +10, no booking found (restaurants, dental-medical, medspa-salon, fitness, home-services) +15, slow (> 3 s) +5, missing title or description +5, has phone +5, category weight (dental-medical +10, professional +10, medspa-salon +5, restaurants +5). Unreachable sites score 0 and are never pitched. Capped at 100.

### Draft rules

Drafts are from Mario Barillas, aimed at 70-100 words (accepted if 50-140). They say it was a quick read-only look at the public home page, and mention only the measured findings (at most two), framed as worth a look. They contain no links, and end with one question offering a short write-up with screenshots: links and attachments from a new sender hurt deliverability, and a question invites a reply. The business name must appear in the subject or body. They never claim a violation of the ADA or any law, mention lawsuits, deadlines, statistics or prices, or promise compliance. A draft that breaks any of these rules is discarded for the next model, then for the template. Drafting goes through `../shared/ai.js` (Gemma 4 with thinking turned off, then Llama 3.3), shared with lead-alert: Gemma 4 is a reasoning model and otherwise spends its whole token budget thinking and returns nothing. The footer (name, company, mailing address, "Reply STOP...") is added by code, not by the AI. The footer shows `[mailing address required before sending]` until the `MAILING_ADDRESS` secret is set.

## Free plan budget

- **10 ms CPU, 50 subrequests, 50 D1 queries per invocation.**
- Check batch: 1 select, then at most `3 * CHECKS_PER_RUN` fetches (robots, home page, and an `http://` retry only when HTTPS fails to connect), then one `db.batch()` write. Parsing is regex-only on at most 150 KB per page.
- Harvest tile (local runs only): one Overpass request per trigger, for one sixth of `BBOX`; rows written with multi-row `INSERT ... ON CONFLICT` statements in a few `db.batch()` calls. Parsing costs roughly 5 microseconds per OpenStreetMap row on a cold isolate, so a tile with up to about 2,000 rows fits in 10 ms. If a tile is ever bigger, raise `GRID_COLS`/`GRID_ROWS` in `src/overpass.js` (a tile counts an attempt before it runs, so a run killed by the CPU limit can't loop forever; it is dropped after 3 attempts). `STATUS` shows the last runs, including failed and dropped tiles.
- Check batch: parsing a typical home page costs a few ms on a cold isolate, so `CHECKS_PER_RUN` is 3; lower it if runs get killed.
- Digest: 1 select, up to `DIGEST_SIZE` AI calls, 1 send, 1 batch write.
- 2 of the 5 cron triggers allowed per account are used.

## Setup (owner only; this repo never contains secrets)

```
cd workers/prospector
npx wrangler d1 migrations apply mobius-prospector --remote   # 0001_init and 0002_harvest_tiles
npx wrangler secret put FOUNDER_TO        # the founder's verified address
npx wrangler secret put MAILING_ADDRESS   # optional, for the email footer
npx wrangler deploy
node scripts/harvest-local.mjs            # fill the prospect list from this PC (repeat monthly)
```

Then add an Email Routing rule that sends `ops@mobiusintegration.com` to the `mobius-prospector` Worker, and make sure `FOUNDER_TO` is a verified destination address for `send_email`.

## Run locally

```
cd workers/prospector
printf 'FOUNDER_TO=founder@example.test\n' > .dev.vars          # git-ignored
npx wrangler d1 migrations apply mobius-prospector --local
npx wrangler dev --test-scheduled --local --port 8799
```

Trigger handlers (the URL-encoded cron string selects the handler):

```
curl "http://127.0.0.1:8799/__scheduled?cron=0+11+*+*+MON"      # plan: queue 6 tiles (no Overpass query)
curl "http://127.0.0.1:8799/__scheduled?cron=*%2F15+*+*+*+*"    # harvests ONE tile (a real Overpass query: be polite) while the queue is non-empty, then check batches
curl "http://127.0.0.1:8799/__scheduled?cron=0+13+*+*+TUE"      # digest
curl -X POST "http://127.0.0.1:8799/cdn-cgi/handler/email?from=founder@example.test&to=ops@mobiusintegration.com" --data-binary @test.eml
```

Local `send_email` writes the message to a file instead of sending. The AI binding is not available with `--local`; the digest then uses the plain template draft. Run `wrangler dev` without `--local` to call the real Workers AI service (D1 and email stay local). Delete the `.wrangler/` folder when done.

## Data and attribution

Business data (c) OpenStreetMap contributors (openstreetmap.org/copyright), used under the ODbL. The database contains no email addresses of prospects. The suppression list can hold addresses the founder explicitly STOPs.
