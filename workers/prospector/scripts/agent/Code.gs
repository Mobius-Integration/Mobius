/**
 * Mobius outbox agent.
 *
 * Runs inside the founder's own Google Workspace mailbox (mario@mobiusintegration.com) as a web app
 * that executes as him. The prospector Worker (workers/prospector/src/outbox.js) calls it to:
 *   send   one email (a first email, or a follow-up in the same thread)
 *   poll   report new replies and bounces
 *   ping   say who it runs as and how many it has sent today
 *
 * Why a script in the mailbox, not an email service: Cloudflare's email service is transactional-only,
 * and sending from the real mailbox keeps every email in his Sent folder and every reply in his inbox.
 *
 * Safety, enforced here whatever the caller asks:
 *   - Every request must carry a token whose SHA-256 matches TOKEN_SHA256 (the token itself isn't here).
 *   - At most DAILY_MAX emails a day, one recipient each, never to the mailbox's own domain.
 *   - Every body must contain the marketing-email notice (CAN-SPAM), so the script can't be used to send
 *     arbitrary mail.
 *   - A follow-up is refused if anyone but the founder has written in that thread.
 * To stop everything: Deploy > Manage deployments > Archive, or delete this project.
 */

var TOKEN_SHA256 = '__TOKEN_SHA256__';
var DAILY_MAX = 30;
var LABEL = 'Mobius outreach';
var NOTICE = 'This is a marketing email from Mobius Integration';
var TZ = 'America/New_York';
var SENDER_NAME = 'Mario Barillas';

// Run this once from the editor (Run > authorize) to approve the permissions.
function authorize() {
  GmailApp.getInboxUnreadCount();
  return me_();
}

function doGet() {
  return json_({ ok: true, service: 'mobius-outbox' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad request' }); }
  if (!authorized_(req.token)) return json_({ ok: false, error: 'unauthorized' });
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
  try {
    if (req.action === 'ping') return json_({ ok: true, me: me_(), sentToday: counter_().n, dailyMax: DAILY_MAX });
    if (req.action === 'send') return json_(send_(req));
    if (req.action === 'poll') return json_(poll_(req));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function authorized_(token) {
  return typeof token === 'string' && token.length >= 32 && sha256Hex_(token) === TOKEN_SHA256;
}

function me_() {
  return Session.getEffectiveUser().getEmail().toLowerCase();
}

function addr_(s) {
  var m = /<([^>]+)>/.exec(String(s || ''));
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

function isBounceSender_(a) {
  return /^(mailer-daemon|postmaster)@/.test(a);
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function counter_() {
  var p = PropertiesService.getScriptProperties();
  var day = today_();
  return { day: day, n: p.getProperty('day') === day ? Number(p.getProperty('count') || 0) : 0 };
}

function bump_() {
  var c = counter_();
  var p = PropertiesService.getScriptProperties();
  p.setProperty('day', c.day);
  p.setProperty('count', String(c.n + 1));
  return c.n + 1;
}

function label_(thread) {
  var l = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  l.addToThread(thread);
}

// ---------------------------------------------------------------------------
// send

function findThread_(to, subject, threadId) {
  if (threadId) {
    try { var t = GmailApp.getThreadById(threadId); if (t) return t; } catch (err) { /* fall through to the search */ }
  }
  var words = subject.replace(/^(re:\s*)+/i, '').replace(/["()]/g, ' ');
  var found = GmailApp.search('in:sent to:' + to + ' subject:(' + words + ') newer_than:60d', 0, 1);
  return found.length ? found[0] : null;
}

function hasOtherSender_(thread, me) {
  var msgs = thread.getMessages();
  for (var i = 0; i < msgs.length; i++) {
    var from = addr_(msgs[i].getFrom());
    if (from !== me && !isBounceSender_(from)) return true;
  }
  return false;
}

function send_(req) {
  var to = String(req.to || '').trim().toLowerCase();
  if (!/^[^\s@<>",;:()]+@[^\s@<>",;:()]+\.[a-z]{2,}$/.test(to)) return { ok: false, error: 'bad address' };
  var me = me_();
  if (to === me || to.split('@')[1] === me.split('@')[1]) return { ok: false, error: 'refusing to email the own domain' };
  var subject = String(req.subject || '').replace(/[\r\n]+/g, ' ').trim();
  var body = String(req.body || '');
  if (!subject || subject.length > 200) return { ok: false, error: 'bad subject' };
  if (body.length < 40 || body.length > 6000) return { ok: false, error: 'bad body length' };
  if (body.indexOf(NOTICE) < 0) return { ok: false, error: 'the marketing notice is missing' };
  if (counter_().n >= DAILY_MAX) return { ok: false, error: 'daily limit reached' };

  var options = { name: SENDER_NAME };
  var thread = null;
  var message = null;
  if (req.followUp) {
    thread = findThread_(to, subject, req.threadId);
    if (thread) {
      if (hasOtherSender_(thread, me)) return { ok: false, replied: true };
      thread.reply(body, options);
      var msgs = thread.getMessages();
      message = msgs[msgs.length - 1];
    }
  }
  if (!message) {
    var subj = req.followUp ? 'Re: ' + subject.replace(/^(re:\s*)+/i, '') : subject;
    message = GmailApp.createDraft(to, subj, body, options).send();
    thread = message.getThread();
  }
  label_(thread);
  return { ok: true, thread_id: thread.getId(), message_id: message.getId(), sent_today: bump_(), to: message.getTo() };
}

// ---------------------------------------------------------------------------
// poll: replies and bounces

// The reply without the quoted email under it.
function stripQuoted_(text) {
  var lines = String(text || '').replace(/\r/g, '').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*>/.test(line) || /^\s*On .{5,120}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) || (/^\s*From:\s.+/.test(line) && out.length)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function isAuto_(m) {
  if (/^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|away from|vacation|undeliverable)/i.test(m.getSubject())) return true;
  try {
    var raw = m.getRawContent().slice(0, 6000);
    return /^(auto-submitted:\s*auto-(replied|generated)|x-autoreply:|x-autorespond:|precedence:\s*auto_reply)/im.test(raw);
  } catch (err) {
    return false;
  }
}

// A bounce notice's failed recipient and reason, or null if the text isn't a permanent failure.
function parseBounce_(text, me) {
  var t = String(text || '');
  if (/(will (keep )?(retry|trying)|temporary problem|delivery incomplete|delayed)/i.test(t)) return null;
  if (!/(wasn'?t delivered|was not delivered|couldn'?t be delivered|could not be delivered|delivery (has )?failed|delivery to the following recipients? failed|failed permanently|undeliverable|address not found|user unknown|mailbox unavailable|no such user|5\.1\.1)/i.test(t)) return null;
  var m = /Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i.exec(t)
    || /wasn'?t delivered to\s+<?([^\s<>]+@[^\s<>]+)>?/i.exec(t)
    || /delivery to the following recipients? failed[^\n]*\n+\s*<?([^\s<>]+@[^\s<>]+)>?/i.exec(t)
    || /<([^\s<>]+@[^\s<>]+)>/.exec(t);
  if (!m) return null;
  var to = m[1].replace(/[.,;:)]+$/, '').toLowerCase();
  if (to === me) return null;
  var why = /(because[^\n.]{0,160}|The response from the remote server was:\s*\n?[^\n]{0,160}|Diagnostic-Code:[^\n]{0,160})/i.exec(t);
  return { to: to, reason: (why ? why[0] : '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

function poll_(req) {
  var me = me_();
  var since = req.since ? new Date(req.since).getTime() : NaN;
  if (isNaN(since)) since = Date.now() - 24 * 3600 * 1000;
  var events = [];
  var seen = {};
  var threads = [];
  var label = GmailApp.getUserLabelByName(LABEL);
  if (label) threads = threads.concat(label.getThreads(0, 60));
  var watch = (req.watch || []).filter(function (a) { return /^[^\s@<>",;:()]+@[^\s@<>",;:()]+\.[a-z]{2,}$/.test(a); }).slice(0, 100);
  for (var i = 0; i < watch.length; i += 12) {
    threads = threads.concat(GmailApp.search('from:(' + watch.slice(i, i + 12).join(' OR ') + ') newer_than:30d', 0, 30));
  }
  threads.forEach(function (th) {
    if (th.getLastMessageDate().getTime() <= since) return;
    th.getMessages().forEach(function (m) {
      var id = m.getId();
      if (m.getDate().getTime() <= since || seen[id]) return;
      var from = addr_(m.getFrom());
      if (from === me || isBounceSender_(from)) return;
      seen[id] = true;
      events.push({ type: 'reply', id: id, thread_id: th.getId(), from: from, subject: m.getSubject(), date: m.getDate().toISOString(), text: stripQuoted_(m.getPlainBody()).slice(0, 600), auto: isAuto_(m) });
    });
  });
  GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:7d', 0, 30).forEach(function (th) {
    th.getMessages().forEach(function (m) {
      var id = m.getId();
      if (m.getDate().getTime() <= since || seen[id]) return;
      var b = parseBounce_(m.getPlainBody(), me);
      if (b) { seen[id] = true; events.push({ type: 'bounce', id: id, to: b.to, reason: b.reason, date: m.getDate().toISOString() }); }
    });
  });
  return { ok: true, events: events, now: new Date().toISOString(), me: me };
}
