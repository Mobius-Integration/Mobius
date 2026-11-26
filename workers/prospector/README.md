# mobius-prospector

A Cloudflare Worker that finds local Tampa Bay businesses with websites, does one polite read-only check of each home page, drafts outreach, and runs the founder's prospect board on the site's own domain.

**Since 2026-11-23 first emails and follow-ups go out automatically** from the founder's own mailbox, through a script in that mailbox (see [Auto-send and follow-ups](#auto-send-and-follow-ups-since-2026-11-23)). **Replies never do:** since 2026-11-24 a reply gets a draft answer in Gmail, often with the write-up the first email offered attached, and the founder reads it and sends it himself (see [Reply kit and write-ups](#reply-kit-and-write-ups-since-2026-11-24)).

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

Drafts are from Mario Barillas, aimed at 70-100 words (accepted if 50-140). They say it was a quick read-only look at the public home page, and mention only the measured findings (at most two), framed as worth a look. They contain no links, and end with one question offering a short write-up with screenshots: links and attachments from a new sender hurt deliverability, and a question invites a reply. The business name must appear in the subject or body. They never claim a violation of the ADA or any law, mention lawsuits, deadlines, statistics or prices, or promise compliance. A draft that breaks any of these rules is discarded for the next model, then for the template. The honest founding-client paragraph (`FOUNDING_LINE`) and the ending are added by code, not by the AI. The ending is a plain-text signature (`TEXT_SIGNATURE`: name, "Founder, Mobius Integration", phone · website) and one compliance line: "This is a marketing email from Mobius Integration, <MAILING_ADDRESS>. Reply STOP and I won't email you again."

The signature is in the draft because Gmail adds the founder's Gmail signature only to emails he starts himself. Tested 2026-11-21: Gmail on the web (the `view=cm` link and the mailto handler) and the Gmail phone app (a real send through the board's deep link) both leave it off any compose that opens with a pre-filled body. Plain text also suits cold-email deliverability.

The rich Gmail signature on mario@ (one table, inline styles, no images, one link; a copy is in `_planning/email-signature.html`, outside git) covers the founder's other emails and replies. **Copy message** (for contact forms) drops the email-only compliance line (`formText()` in `src/digest.js`).

## Budget (Workers Paid since 2026-11-20)

- 30 s of CPU per invocation (`[limits] cpu_ms`) and far more subrequests than the free plan's 50.
- Check batch: `CHECKS_PER_RUN` (10) prospects in parallel, each at most 3 fetches (robots, home page, an `http://` retry), about 3-4 ms of CPU per full-size page, one `db.batch()` write.
- Digest and "Get more": up to `DIGEST_SIZE` AI drafts (within the free daily Workers AI allowance) and up to 2 contact-lookup GETs per pick.
- Write-ups: about 10 seconds of Browser Run time each, one browser at a time. Browser Run is billed by browser time beyond the plan's included allowance (see the Cloudflare dashboard); at a few write-ups a day it stays small.
- 2 cron triggers.

## Setup (owner only; this repo never contains secrets)

```
cd workers/prospector
npm install                               # @cloudflare/puppeteer and axe-core, for the write-ups
npx wrangler d1 migrations apply mobius-prospector --remote   # 0001_init through 0006_reply_kit
npx wrangler secret put FOUNDER_TO        # the founder's verified address
npx wrangler secret put MAILING_ADDRESS   # optional, for the email footer
npx wrangler deploy                       # also creates the route mobiusintegration.com/ops/*
node scripts/harvest-local.mjs            # fill the prospect list from this PC (repeat monthly)
node scripts/check-local.mjs              # check the new prospects from this PC (--requeue re-checks everyone)
node scripts/contacts-local.mjs           # fill in contact routes the cloud couldn't load
```

Google Workspace handles mail for mobiusintegration.com itself (since 2026-11-20), so Cloudflare Email Routing for this Worker runs on the subdomain `in.mobiusintegration.com`: an Email Routing rule sends `ops@in.mobiusintegration.com` (`OPS_ADDRESS`) to the `mobius-prospector` Worker, digests come from `prospects@in.mobiusintegration.com`, and `FOUNDER_TO` must be a verified destination address for `send_email`. The founder may write from `FOUNDER_TO` or `FOUNDER_FROM` (his Workspace address).

## Law firms and referral partners (since 2026-11-23)

Every prospect has a `track` (migration 0004; logic in `src/partners.js`):

- **client**: we pitch our own services (the AI drafts above). Law firms whose clients are mostly people (personal injury, family, criminal, estate, immigration and so on) are clients too. Their drafts get one code-inserted line before the founding paragraph offering a confidentiality agreement (`LAW_LINE`), and the AI is told not to comment on their cases, clients or the law. Forbidden-word checks skip the firm's own name, so "Tampa Legal Group" doesn't trip on "legal".
- **partner**: businesses whose clients are businesses: business, real estate, tax and IP lawyers; accountants, bookkeepers, payroll and tax preparers; independent insurance agencies; print and sign shops. Their drafts are fixed templates (`partnerDraft()`, model `partner-template`): no site findings, no AI, no founding paragraph, same signature and compliance line. Each batch (weekday digest or Get more) holds up to `PARTNER_SLOTS` partners (default 1), lawyers first, then accountants, then the rest; their site only has to load.

**Rewards (the founder's decision, 2026-11-23; public terms at `/partners/` on the site):** lawyers are never paid for referring a client. Florida Bar Ethics Opinion 02-8 and the opinions it cites have a lawyer who takes a referral payment tell the client in writing and pass the benefit on, and other states treat it as a conflict consent can't cure, worst when payments repeat as the client buys more. So a business a lawyer refers gets its first month free (or the Fix Plan at no charge), and referrals with lawyers run both ways with no fees. Other partners get a flat $297 once the client they sent has paid its second month. First emails say "a flat thank-you" and never the amount.

`outreach.angle` records which draft went out (`client`, `law-client`, `partner-lawyer`, `partner-accounting`, `partner-insurance`, `partner-print`), for reply rates by angle.

## Auto-send and follow-ups (since 2026-11-23)

The founder asked for automatic messages and follow-ups, reversing his 2026-11-20 "keep it manual" call. Rules: `src/outbox-rules.js`; engine: `src/outbox.js`; the sender: `scripts/agent/Code.gs`.

- **The agent.** Cloudflare's own email service is transactional-only (its FAQ answers "Can I use Email Service for marketing emails? No."), and a suspended Cloudflare account would take the site down, so cold email doesn't go through it. Instead a Google Apps Script web app runs inside the founder's mario@ mailbox and sends through it (Sent folder and inbox stay real). The Worker holds no mail credentials: it calls the script with a random token (`meta.agent_token`; only its SHA-256 is in the script) at `meta.agent_url`, which must be a `script.google.com` web app address (`src/agent.js`). The script keeps its own limits: 30 a day, one recipient, never the mailbox's own domain, the marketing notice required in every body, and a follow-up refused if that person has written back anywhere. To stop everything: archive the deployment or delete the script, or tap Pause on the board.
- **Setup (done 2026-11-23).** Create a project at script.google.com as mario@, paste `Code.gs` with `__TOKEN_SHA256__` replaced by the token's hash, run `authorize` (the permission screen reads "Read, compose, send, and permanently delete all your email from Gmail", Google's wording for `GmailApp`), deploy as a web app (Execute as: Me, Who has access: Anyone), then store the token and the `/exec` address in `meta`. A code change needs a new deployment version (Deploy > Manage deployments > pencil > New version); the address stays the same.
- **What the Worker does.**
  - **Weekday morning (13:00 UTC cron):** `fillQueue` adopts waiting drafts that have an address it may use, then picks new businesses (a partner for about every fourth place), looks up each contact route, drafts, and gives each email a send time spread across 9:30 AM to 3:30 PM Eastern. The founder gets a plan email. Board's Top up the queue does the same.
  - **Every 15 minutes (cloud only):** `outboxTick` reads replies and bounces from the agent, schedules follow-ups, and sends at most one due email.
- **Safety, in order.** Daily cap ramps from 8 to 20 (`AUTO_START_PER_DAY`, `AUTO_MAX_PER_DAY`; +2 every 3 days after the first send, all kinds of email counted). Weekdays only, no major holidays, restaurants wait out Thanksgiving week. Before each send: do-not-contact list, a mail server for the address's domain, the site still opens on the same domain, and (clients) a fresh check where every finding the draft quotes must still be there, else the email is held for the founder with the reason. Only addresses the business publishes itself, on its own domain or a free-mail address its site lists; never guessed, and addresses hidden from bots stay hidden.
- **Follow-ups.** A nudge on day 4 (with one more current finding, if known) and a last note a week later, at most two. They stop on a reply, a bounce, a STOP, "Stop follow-ups", or when the site no longer shows the findings.
  - **Since 2026-11-24 (script version 5) they're replies in the first email's thread** ("Re: <subject>", to the prospect). GmailApp's own `reply` and `replyAll` answer the sender of the last message, which is the founder himself (tested live 2026-11-23: both landed in his own inbox). So the script writes the reply by hand, with `In-Reply-To` and `References` pointing at our first email's Message-ID, and sends it with the Gmail API advanced service.
  - The manifest pins `oauthScopes` to the two scopes already granted (`mail.google.com`, `userinfo.email`), so enabling the service needed no new consent.
  - If the service is missing or the API call fails before sending, the follow-up goes as its own "Following up:" email. Once the API has sent, it is never sent a second way.
  - Live test 2026-11-24: in the recipient's Gmail the follow-up landed in the same thread as the first email.
- **Replies.** `classifyReply` reads each one: out-of-office is ignored; a person is marked replied, and their first reply goes to the reply kit (below), which emails the founder once a draft answer is waiting; "stop", "remove me" or a polite no suppresses the address and domain; an angry reply (spam, report, illegal) pauses everything. More than 5% bounces over 10 or more sends also pauses, and so does any email the agent reports sent to the wrong address.
- **Board.** Auto-send panel (On, Paused, Not connected; today's count; Pause, Resume, Top up), Sending automatically (with Cancel this send), Need you (businesses with no usable email, held emails with their reason), per-card follow-up status and Stop follow-ups.
- **Forms.** The prospector never submits contact forms for the founder. Most forms sit behind CAPTCHAs and bot checks, defeating those isn't something to build, and an automated sales message through someone's contact form is the lowest-trust channel there is. No-email businesses go to Need you for a contact form (Copy message) or a call.
- **Tests** live outside the repo, in the session scratchpad: unit checks for the rules and contact finder, the script run in a sandbox with stand-ins for Gmail, and an end-to-end run against Node's SQLite with fake sites, DNS and mailbox.

## Targeting and testing (since 2026-11-24, evening)

- **Before each send,** a real browser (Browser Run) confirms every quoted finding; a day-4 follow-up drops its extra finding if the browser doesn't see it. If the browser can't run, the light check's answer stands.
- **Mornings:** up to `SENDS_PER_TICK` (2) emails per 15-minute run, first emails planned by 12:30 Eastern (11:45 on the day before a holiday), stretched only as far as needed (`lastSlotMinutes`, `isHolidayEve` in `outbox-rules.js`).
- **Who gets picked:** `fillQueue` looks up contacts for about three times as many businesses as there are slots, then prefers a person's address over one named after the business over a shared inbox (`emailRank`). Clients take turns by kind of business (`CLIENT_SEGMENTS`), best score first within each.
- **Subject test:** client emails alternate by prospect id between "A quick look at X’s website" (A) and "Question about X’s website" (B), stored in `outreach.variant` (migration 0007). The board's **What's working** panel shows reply rates by kind of business and by subject.
- **Plain words:** drafts describe findings the way an owner would (`plainFinding` in `digest.js`), and names read cleanly (`src/names.js`: "Jones, P.A.", "Associates Attorneys’ clients").
- **Local businesses:** `node scripts/overture-local.mjs --set local --apply` imports owner-run businesses that book appointments or jobs (`LOCAL_KINDS` in `partners.js`: dental, chiropractic, therapy, eye care, vets, med spas, salons, barbers, gyms and studios, home trades, auto shops) as clients. Booking platforms and directories are skipped (`SKIP_DOMAINS`). First import 2026-11-24: 12,322 businesses; check them with `node scripts/check-local.mjs`.

## Reply kit and write-ups (since 2026-11-24)

Every first email ends by offering "a short write-up of what I saw, with screenshots". The reply kit makes that offer instant. Code: `src/replykit.js`, `src/writeup.js`; tables `replies` and `writeups` (migration 0006); PDFs in the `WRITEUPS` KV namespace for 120 days.

- **When a person replies** (their first reply; later ones just get the usual notice), the next 15-minute run:
  1. reads what they want with fixed rules (`replyIntent`: yes, question, call, later, no, other);
  2. for a client who didn't say no, makes the write-up (or reuses one from the last 3 days);
  3. writes the reply from fixed templates (`composeDraft`). The only AI-written words are a one-to-three sentence answer to a question, built from the site's own `src/_data/packages.js` and checked by `answerOk` (prices must be real ones, links only to mobiusintegration.com's pricing or partners pages, no legal talk); anything that fails becomes an offer to talk;
  4. asks the agent's `draft` action to leave it as a **draft** reply in that Gmail thread, PDF attached. Nothing is sent: the founder gets an email ("your draft answer is waiting in Gmail") and sends it himself.
- **Partners** get the referral terms (lawyers: the client's first month free, no fees either way; others: the flat $297 thank-you) and a coffee-or-call ask, never a write-up.
- **The write-up** (`makeWriteup`) opens the page once in Cloudflare's real Chrome (Browser Run, the `BROWSER` binding), at computer and phone sizes, runs axe-core with the WCAG 2.1 A and AA rules, screenshots up to two examples of each finding with a red outline drawn over them, and prints a two-to-four page Letter PDF: the first email's findings first, at most five, each with what it means, why it matters and the fix, then how it was checked, the founding paragraph and the signature. A finding the first email quoted that the browser no longer sees is left out, and the founder is told. Certificate errors are ignored for that one visit (the warning is itself the finding). Chrome refuses plain-http navigations under automation, so an http-only page is rendered from a copy fetched over http with a `<base>` tag. About 8-11 seconds and 450-650 KB each.
- **Board.** Every client card has **Make write-up (PDF)** (for a call, a walk-in, or a reply by hand) and, once one exists, **Open write-up (PDF)**; a card with a reply shows what they wrote, the draft's state and **Open in Gmail**.
- **The agent** (`draft` action, since script version 4) only ever drafts a reply to a message that person sent in that thread, never to the mailbox's own domain, one draft per thread, PDF only, at most 8 MB; drafts don't count toward the daily send limit.
- **Live test 2026-11-24:** a reply from the founder's own Gmail got a draft with a real write-up attached, in that thread, addressed back to the sender; a second request left the waiting draft alone.

## Overture import (PC only)

`scripts/overture-local.mjs` reads Overture Maps places (open data, about 25 MB for the box) with DuckDB, installed separately in `scripts/overture/` (`npm install` there once; it is not part of the Worker or the site build). It imports law firms and partner kinds only, skipping closed and low-confidence places, brands, captive agents of national insurers, franchise tax offices, social and listing sites, and any website shared by 3 or more places. It never reads Overture's email addresses. New rows land as `new`, so run `node scripts/check-local.mjs` next. A dry run is the default; `--apply` writes. First import 2026-11-23 (release 2026-11-18.0): 2,336 law-firm clients and 2,694 partners.

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

Business data (c) OpenStreetMap contributors (openstreetmap.org/copyright), used under the ODbL. Rows with `source = 'overture'` come from Overture Maps Foundation places data (overturemaps.org), released under CDLA Permissive 2.0. Email addresses in the database are only those the businesses publish on their own websites, for prospects that were in a digest, plus addresses the founder emailed or explicitly STOPped.
# Discord office

Discord is optional. With no `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`, the Worker makes no Discord calls and its existing email and board behavior stays in place.

## What posts where

- `#hq`: the weekday auto-send plan and morning queue summary.
- `#approvals`: held sends, auto-send pauses, and delivery trouble. Alerts offer Pause or Resume, and held sends can be cancelled.
- `#replies`: prospect replies, including angry replies, and drafted-answer notices, with a Gmail link when available.
- `#outreach`: successful first sends and follow-ups, plus bounce alerts. Send notices include Stop follow-ups.
- `#builds`: reserved for code and agent updates.
- `#tasks`: the forum for agent tasks, tagged proposed, approved, in-progress, review, and done.

## Codex in the chat

The token-protected board routes let the PC job runner post plain-text start and finish updates to `#builds` or `#hq`. It can also list approved threads from `#tasks`, then post an update in a task thread and move its tag to in-progress, review, or done. These routes use the existing signed board link and the configured Discord bot; they do not send email.

Messages include buttons where the board offers the same action: pause or resume auto-send, cancel a queued send, and stop follow-ups. Only the Discord server owner saved during setup can use them.

## Setup

1. Create a Discord application and bot, then add the app ID and public key to `[vars]` as `DISCORD_APP_ID` and `DISCORD_PUBLIC_KEY` in `wrangler.toml`.
2. Set the bot token as a Worker secret: `npx wrangler secret put DISCORD_BOT_TOKEN`. Never put the token in a file.
3. Invite the bot to Mario's private server with this OAuth2 permissions URL (replace `APPLICATION_ID`): `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&permissions=326417640464&scope=bot`. It requests: View Channels, Send Messages, Manage Messages (to pin the welcome panel), Attach Files (texture studies), Embed Links, Read Message History, Manage Channels, Create Public Threads, Send Messages in Threads, and Manage Threads.
4. In the Discord Developer Portal, set the Interactions Endpoint URL to `https://mobiusintegration.com/discord/interactions`.
5. Open the prospect board, copy the server ID with Discord Developer Mode enabled, enter it in the Discord server ID field, and press **Set up Discord**. Setup creates missing channels and categories, saves their IDs and the server owner's ID in D1, and can be run again safely.

To switch Discord off, remove the `DISCORD_BOT_TOKEN` secret and clear both Discord vars. Existing Discord channels and messages remain in Discord; the Worker stops posting and rejects interactions without a public key.

## Studio

Studio is a brand design and marketing partner for Mario in `#brand-studio`. Send a message to shape the Mobius identity. It asks one discovery question at a time and can suggest colours, typography, textures, voice, and taglines. Use the pinned **Show brand brief** button to review decisions or **Send brand kit to the builder** to save the kit in KV, summarize it in `#builds`, and propose a website task in `#tasks`. Only configured Discord admins are acted on.

The minute cron polls new channel messages using Discord's `after` cursor, batches each minute's eligible admin messages into one turn, and saves the cursor and conversation in D1. A PC running `scripts/studio-pc.mjs` heartbeats every 10 seconds and claims queued turns. Codex answers while that heartbeat is under three minutes old; when it is stale, Studio answers with Workers AI. Turns still waiting after four minutes receive a Cloudflare reply. The PC uses Mario's signed board URL, stored in a one-line file named by `STUDIO_BOARD_URL_FILE`; keep that file private. It writes one-line turn logs to `scripts/studio-pc.log`.

Start the PC worker from `workers/prospector` with `node scripts/studio-pc.mjs` and keep it running at logon. `node scripts/studio-pc.mjs --once` performs one poll for a local check. To force Cloudflare-only answers, set Worker var `STUDIO_BRAIN = "cloudflare"`. Codex turns use Mario's ChatGPT plan through the signed-in Codex CLI; backup answers and all generated images use Workers AI. Daily limits remain 150 chat calls and 30 images per UTC day by default; override with `STUDIO_MAX_CALLS_PER_DAY` and `STUDIO_MAX_IMAGES_PER_DAY`.

Enable the bot's Message Content intent in the Discord Developer Portal. Studio can be disabled with `STUDIO_ENABLED = "false"` in Worker vars.

The defaults are `@cf/openai/gpt-oss-120b` for chat and `@cf/black-forest-labs/flux-1-schnell` for images. Cloudflare currently lists both. At listed rates, 150 turns are usage-metered by tokens (gpt-oss-120b: $0.35/M input and $0.75/M output tokens); 30 512×512 FLUX tiles are about $0.0016 total at $0.0000528 each. Actual chat cost depends on context and reply size. [Model details](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Before rollout, apply migrations `0008_brand_studio.sql` and `0009_studio_turns.sql`, deploy the Worker, then start the PC script. Rerun **Set up Discord** from the board if the channel panel is not present. The Discord bot needs Attach Files permission for texture images.
# Office

The Office holds daily standups in Discord `#office` at 9 AM, 12 PM, 3 PM, 6 PM and 9 PM America/New_York. Each run creates a thread, then queues the Chief's opening, Growth and Studio work, their discussion turns, and the Chief's wrap. The agents post under their own names. Studio can render proposed textures into the thread. Results and notebooks are validated and kept in D1. Proposals appear in `#tasks` with Approve and Reject buttons; only configured Discord admins can decide them.

Use **Run a standup now** on the pinned `#office` control message for a manual run. **Pause the office** stops new runs; **Resume** starts the schedule again. The Worker uses `OFFICE_MAX_TURNS_PER_RUN` (default 8) and `OFFICE_MAX_RUNS_PER_DAY` (default 6), each capped in code. PC Codex turns count against the existing daily Studio call cap (`STUDIO_MAX_CALLS_PER_DAY`); when the PC is unavailable or Codex fails, Workers AI answers instead. Cloudflare answers are labeled in Discord.

Run `setupDiscord` again after applying migration `0010_office.sql` so it creates `#office`, its app-owned webhook and pinned controls. Deploy the Worker manually after review; do not deploy from this repository.
