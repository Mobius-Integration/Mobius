# mobius-prospector

A Cloudflare Worker that finds local Tampa Bay businesses with websites, does one polite read-only check of each home page, and every weekday morning emails the founder the best new prospects with drafted outreach emails and tap buttons. A prospect board on the site's own domain holds everything waiting to be sent.

**Nothing is ever sent to a prospect automatically.** The founder reads each draft and sends it himself, one at a time.

## Rules this Worker follows

1. **Mail goes to the founder only.** The single send path is `sendToFounder()` in `src/index.js`. It has no recipient parameter: it always sends to the `FOUNDER_TO` secret and refuses if that is missing, malformed, or doesn't match the message's `To` header.
2. **No bulk email harvesting.** The prospect list holds only what OpenStreetMap publishes about a business: name, website, phone, city, category. Only for a prospect picked for a digest (a handful a day) does the Worker look up the contact route the business publishes on its own website: its contact page link, and an email address shown there as a `mailto:` link or as text (`src/contacts.js`). It never guesses an address, never decodes an address a site hides from bots (Cloudflare email protection, HTML-entity encoding), and skips addresses credited to a web designer.
3. **Polite, read-only checks.** One GET of the home page plus `/robots.txt` per prospect, short timeouts (3 s and 8 s), an identifying User-Agent (`... MobiusProspector/1.0; +https://mobiusintegration.com`), a 150 KB read cap, redirects only. If the `User-agent: *` group of `robots.txt` has `Disallow: /`, the site is skipped (`robots_skip`). It never submits forms. The contact lookup adds at most one more GET (the contact page).
4. **Untrusted input.** Website HTML and OpenStreetMap text are escaped in HTML output, fenced as data in AI prompts, and AI drafts are rejected (replaced by a plain template) if they use forbidden words.
5. **No secrets in the repo.** The founder's address is the secret `FOUNDER_TO`; the optional postal address for the email footer is the secret `MAILING_ADDRESS`. The board's signing key is the optional secret `ACTION_KEY`, or a random key the Worker generates once and keeps in D1.

## How it works

**The harvest runs on the founder's PC, not in the cloud.** Public Overpass servers answer Cloudflare's network with HTTP 521 or time out (seen 2026-11-15), but answer a home connection normally. `node scripts/harvest-local.mjs` (from this folder) runs this Worker's own code with `wrangler dev`, with the D1 binding pointed at the live database and `HARVEST_HERE="true"`. It plans the harvest, then harvests one tile per trigger until the queue is empty: 20 tiles (`BBOX` as a `GRID` of 4 x 5, covering Hillsborough, Pinellas, Pasco, Plant City and Lakeland), one Overpass query each, about 15-25 minutes. Monthly is plenty. Then `node scripts/check-local.mjs` checks the new prospects from the same PC, because many small-business sites refuse Cloudflare's network. While a PC run is working it keeps a heartbeat in `meta`, and the cloud's own check batches pause so they don't race it.

| Trigger | What it does |
| --- | --- |
| Plan (`0 11 * * MON`, local harvest only) | No Overpass query. Resets every prospect's `sightings` to 0 and queues the tiles in `meta['harvest_queue']`. |
| `*/15 * * * *` | **Local harvest only, while tiles are queued: harvest ONE tile** (one Overpass query, three endpoints with 30 s between tries, a failed tile is retried up to 3 times). Drops social/aggregator links, chains and big national names, maps each to an audience id, and upserts into D1 (`src/overpass.js`). **Otherwise: check batch.** Takes up to `CHECKS_PER_RUN` new prospects, checks `robots.txt`, runs `checkSite()` from `../shared/site-check.js` (with the HTTP fallback below), and stores the result and an opportunity score 0-100 (`src/score.js`). |
| `0 13 * * MON-FRI` | **Weekday digest.** If fewer than `READY_CAP` prospects are waiting on the board, picks up to `DIGEST_SIZE` checked prospects with a score of at least `MIN_SCORE`, looks up each one's contact route, drafts an outreach email with Workers AI (Gemma 4, then Llama 3.3, then a plain template), appends the required footer in code and emails one digest to the founder (`src/digest.js`). A full board gets no new picks; on Mondays it gets a reminder instead. |

### The prospect board

`https://mobiusintegration.com/ops/b/<expiry>/<signature>`, served by this Worker on the routes `mobiusintegration.com/ops` and `mobiusintegration.com/ops/*` (`src/board.js`). Every digest carries a fresh link; each works for 45 days. The signature is HMAC-SHA256 over the expiry (`src/tokens.js`), so only links this Worker issued work. Pages are never cached or indexed, send no Referer to the sites they link to, allow only their own nonce'd inline script and style, and accept state changes only as JSON from their own script.

**Permanent address: `https://mobiusintegration.com/ops`.** Opening a genuine board link gives that browser a device cookie: `__Secure-ops`, HMAC over `device|<expiry>` (so a board signature can't pose as one), valid 180 days and renewed on every board visit, `HttpOnly; Secure; SameSite=Lax; Path=/ops`. With it, `/ops` and any bookmarked or Home Screen board whose link has expired redirect (302) to a fresh board link, and a digest button's `?do=&id=` rides along. Without it, `/ops` shows one button, **Email me a fresh link** (`POST /ops/link`, JSON only), which sends a fresh link through `sendToFounder()`. That has no recipient parameter, so a stranger can at most send the founder his own link, and it's limited to one email per 10 minutes and 5 a day (`meta.link_sends`). Board responses send HSTS (`max-age=31536000`, apex only), because the Secure cookie never travels over plain http. To sign every device out and kill every link at once, delete the signing key (`DELETE FROM meta WHERE key = 'action_key'`, or rotate `ACTION_KEY`); the next digest brings a new link.

Each prospect has:

- **Write in Gmail** opens the draft in the Gmail app on an iPhone or Android phone (Gmail on the web on a computer; **Other mail app** uses `mailto:`), addressed to them when their site lists an email, with a hidden copy (Bcc) to `OPS_ADDRESS`. When the founder sends it, that copy reaches this Worker's `email` handler, which marks the prospect sent (`src/marks.js`: matched by the address, their website's domain, or the drafted subject). Nothing is forwarded. A copy that matches nobody gets the founder a short note instead.
- **Sent ✓** (for contact forms and phone calls), **Skip**, **Never contact** (adds the domain to the suppression list), **They replied**, and **Undo** for each.
- **Get 5 more**: drafts the next `DIGEST_SIZE` prospects straight onto the board, without an email.

The buttons in the digest email open the board with `?do=<action>&id=<n>`. The board's script applies it (link scanners that don't run scripts change nothing), shows it, and offers Undo. Every change is logged in `events`.

### Chain filter across tiles

In each tile, a domain shared by 3 or more OpenStreetMap objects is skipped, and the denylist applies. Each upsert adds the domain's count in that tile to `prospects.sightings` (reset when a harvest is planned), so a domain that adds up to 3 or more across tiles is a chain: the check batch and the digest only consider rows with `sightings < 3`. Known gaps: an object that spans a tile edge can be counted in both tiles, and a chain skipped in one tile (3+ there) but seen once in another is still pitched from the second.

### HTTP-only sites

The stored URL is `https://`. If that GET fails with a connection or TLS error (not an HTTP status, not a timeout), the check makes one more GET to `http://`. If it works, the check is recorded with `https = 0`, so "doesn't load over HTTPS" is a real finding instead of the site looking closed. The fallback is the opt-in `httpFallback` option of `checkSite()`; lead-alert opts in too.

### Commands (the email fallback for the board)

Reply to any prospector email (it goes to `OPS_ADDRESS`), one command per line:

| Command | Effect |
| --- | --- |
| `SENT <domain>` | Mark the prospect as sent |
| `SKIP <domain>` | Don't pitch this one |
| `STOP <domain-or-email>` | Add to the suppression list (lowercase) and mark a matching prospect never contact. For an email address, a prospect on that address's domain is suppressed too |
| `MORE` | Build and send another digest now with the next `DIGEST_SIZE` prospects |
| `STATUS` | Reply with counts per status and the last 5 runs |
| `BOARD` | Reply with a fresh board link (or tap **Email me a fresh link** at `/ops`) |

Only the founder's address is accepted (anything else is rejected with `Not accepted`), and nothing is acted on when the receiving server recorded a DMARC failure. Only the lines before the quoted reply are read. Every reply carries a board link.

### Score

Starts at 10. Adds: no HTTPS +15, no mobile viewport +15, images without alt +5 per 5 (max +15), unlabeled form fields +10, no booking found (restaurants, dental-medical, medspa-salon, fitness, home-services) +15, slow (> 3 s) +5, missing title or description +5, has phone +5, category weight (dental-medical +10, professional +10, medspa-salon +5, restaurants +5). Unreachable sites score 0 and are never pitched. Capped at 100. The digest skips anything under `MIN_SCORE` (30: at least one real finding).

### Draft rules

Drafts are from Mario Barillas, aimed at 70-100 words (accepted if 50-140). They say it was a quick read-only look at the public home page, and mention only the measured findings (at most two), framed as worth a look. They contain no links, and end with one question offering a short write-up with screenshots: links and attachments from a new sender hurt deliverability, and a question invites a reply. The business name must appear in the subject or body. They never claim a violation of the ADA or any law, mention lawsuits, deadlines, statistics or prices, or promise compliance. A draft that breaks any of these rules is discarded for the next model, then for the template. The honest founding-client paragraph (`FOUNDING_LINE`) and the ending are added by code, not by the AI. The ending is "Mario" plus one compliance line: "This is a marketing email from Mobius Integration, <MAILING_ADDRESS>. Reply STOP and I won't email you again."

Name, title, phone and website come from the Gmail signature on mario@ (set up 2026-11-21; a copy is in `_planning/email-signature.html`, outside git), which Gmail adds below the draft. It is a single table with inline styles, no images and one link, which suits cold-email deliverability. Gmail on the web leaves the signature off any compose that opens with a pre-filled body, including the board's `view=cm` link and the mailto handler, so the board says to click Insert signature on a computer. The address therefore stays in the compliance line, and every email is compliant with or without the signature. **Copy message** (for contact forms) swaps the email-only ending for a plain-text signature (`formText()` in `src/digest.js`).

## Budget (Workers Paid since 2026-11-20)

- 30 s of CPU per invocation (`[limits] cpu_ms`) and far more subrequests than the free plan's 50.
- Check batch: `CHECKS_PER_RUN` (10) prospects in parallel, each at most 3 fetches (robots, home page, an `http://` retry), about 3-4 ms of CPU per full-size page, one `db.batch()` write.
- Digest and "Get more": up to `DIGEST_SIZE` AI drafts (within the free daily Workers AI allowance) and up to 2 contact-lookup GETs per pick.
- 2 cron triggers.

## Setup (owner only; this repo never contains secrets)

```
cd workers/prospector
npx wrangler d1 migrations apply mobius-prospector --remote   # 0001_init, 0002_harvest_tiles, 0003_board
npx wrangler secret put FOUNDER_TO        # the founder's verified address
npx wrangler secret put MAILING_ADDRESS   # optional, for the email footer
npx wrangler deploy                       # also creates the route mobiusintegration.com/ops/*
node scripts/harvest-local.mjs            # fill the prospect list from this PC (repeat monthly)
node scripts/check-local.mjs              # check the new prospects from this PC (--requeue re-checks everyone)
node scripts/contacts-local.mjs           # fill in contact routes the cloud couldn't load
```

Google Workspace handles mail for mobiusintegration.com itself (since 2026-11-20), so Cloudflare Email Routing for this Worker runs on the subdomain `in.mobiusintegration.com`: an Email Routing rule sends `ops@in.mobiusintegration.com` (`OPS_ADDRESS`) to the `mobius-prospector` Worker, digests come from `prospects@in.mobiusintegration.com`, and `FOUNDER_TO` must be a verified destination address for `send_email`. The founder may write from `FOUNDER_TO` or `FOUNDER_FROM` (his Workspace address).

## Run locally

```
cd workers/prospector
printf 'FOUNDER_TO=founder@example.test\nACTION_KEY=local-test-key-at-least-32-characters\n' > .dev.vars   # git-ignored
npx wrangler d1 migrations apply mobius-prospector --local
npx wrangler dev --test-scheduled --port 8799
```

Trigger handlers (the URL-encoded cron string selects the handler):

```
curl "http://127.0.0.1:8799/__scheduled?cron=0+11+*+*+MON"         # plan: queue the tiles (no Overpass query)
curl "http://127.0.0.1:8799/__scheduled?cron=*%2F15+*+*+*+*"       # harvests ONE tile (a real Overpass query: be polite) while the queue is non-empty, then check batches
curl "http://127.0.0.1:8799/__scheduled?cron=0+13+*+*+MON-FRI"     # digest
curl -X POST "http://127.0.0.1:8799/cdn-cgi/handler/email?from=founder@example.test&to=ops@in.mobiusintegration.com" --data-binary @test.eml
```

A test email needs `Message-ID` and `Date` headers. Local `send_email` writes the message to a file instead of sending. Workers AI always runs remotely (small usage charges). Delete `.dev.vars` and the `.wrangler/` folder when done.

## Data and attribution

Business data (c) OpenStreetMap contributors (openstreetmap.org/copyright), used under the ODbL. Email addresses in the database are only those the businesses publish on their own websites, for prospects that were in a digest, plus addresses the founder emailed or explicitly STOPped.
