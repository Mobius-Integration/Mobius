// Prospect state changes: board buttons, buttons in the digest email, the hidden copy of a sent email,
// and the old reply commands all go through markProspect(), so every path writes the same rows and
// the same event log.

export const ACTIONS = new Set(["sent", "skip", "never", "replied", "unreplied", "undo"]);

const LATEST = `SELECT p.id, p.domain, p.name, p.status, o.id AS oid, o.sent_at, o.sent_via, o.replied_at
  FROM prospects p LEFT JOIN outreach o ON o.id = (SELECT MAX(id) FROM outreach WHERE prospect_id = p.id)
 WHERE p.id = ?`;

// "2026-11-20 14:05:00" (UTC, from SQLite) -> "Nov 20" in Tampa's time zone.
export function shortDate(sqlUtc) {
  if (!sqlUtc) return "";
  const d = new Date(String(sqlUtc).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  } catch {
    return d.toISOString().slice(5, 10);
  }
}

export function statusLabel(status, row = {}) {
  if (status === "digested") return "Ready to send";
  if (status === "sent") {
    const when = shortDate(row.sent_at);
    const how = row.sent_via === "gmail" ? " (seen in Gmail)" : "";
    return `Sent ✓${when ? ` ${when}` : ""}${how}${row.replied_at ? " · They replied" : ""}`;
  }
  if (status === "skipped") return "Skipped";
  if (status === "suppressed") return "Never contact (on the do-not-contact list)";
  return status;
}

// action: sent | skip | never | replied | unreplied | undo. via: board | email-button | gmail | command.
// extra.to: the address the email went to (from the hidden copy). Returns { ok, status, replied, label, name }
// or { ok: false, error }.
export async function markProspect(env, id, action, via, extra = {}) {
  const db = env.DB;
  if (!ACTIONS.has(action)) return { ok: false, error: "Unknown action." };
  const p = await db.prepare(LATEST).bind(id).first();
  if (!p) return { ok: false, error: "That prospect isn't in the database." };

  const stmts = [];
  const setStatus = (status) => stmts.push(db.prepare("UPDATE prospects SET status=?, updated_at=datetime('now') WHERE id=?").bind(status, id));
  const setOutreach = (sql, ...binds) => {
    if (p.oid) stmts.push(db.prepare(`UPDATE outreach SET ${sql}, updated_at=datetime('now') WHERE id=?`).bind(...binds, p.oid));
  };

  if (action === "sent") {
    if (p.status === "suppressed") return { ok: false, error: `${p.name} is on the do-not-contact list. Tap Undo first if that was a mistake.` };
    setStatus("sent");
    const to = extra.to ? String(extra.to).toLowerCase().slice(0, 254) : null;
    setOutreach(
      "founder_status='sent', sent_at=COALESCE(sent_at, datetime('now')), sent_via=COALESCE(sent_via, ?), sent_to=COALESCE(?, sent_to), contact_email=COALESCE(contact_email, ?)",
      via, to, to,
    );
  } else if (action === "skip") {
    if (p.status === "suppressed") return { ok: false, error: `${p.name} is on the do-not-contact list already.` };
    setStatus("skipped");
    setOutreach("founder_status='skipped'");
  } else if (action === "never") {
    stmts.push(db.prepare("INSERT OR IGNORE INTO suppression (value, reason) VALUES (?, ?)").bind(p.domain, `founder: never contact (${via})`));
    setStatus("suppressed");
    if (p.status !== "sent") setOutreach("founder_status='skipped'");
  } else if (action === "replied" || action === "unreplied") {
    if (p.status !== "sent" || !p.oid) return { ok: false, error: `Mark ${p.name} as sent first.` };
    setOutreach(action === "replied" ? "replied_at=COALESCE(replied_at, datetime('now'))" : "replied_at=NULL");
  } else if (action === "undo") {
    if (!["sent", "skipped", "suppressed"].includes(p.status)) {
      return { ok: true, status: p.status, replied: !!p.replied_at, label: statusLabel(p.status, p), name: p.name };
    }
    if (p.status === "suppressed") {
      // Lift the founder's block (reasons starting "founder"). A prospect already emailed goes back to sent.
      stmts.push(db.prepare("DELETE FROM suppression WHERE value=? AND reason LIKE 'founder%'").bind(p.domain));
      if (p.sent_at) setStatus("sent");
      else {
        setStatus(p.oid ? "digested" : "checked");
        setOutreach("founder_status='drafted'");
      }
    } else {
      setStatus(p.oid ? "digested" : "checked");
      setOutreach("founder_status='drafted', sent_at=NULL, sent_via=NULL, sent_to=NULL, replied_at=NULL");
    }
  }
  stmts.push(db.prepare("INSERT INTO events (prospect_id, action, via, detail) VALUES (?,?,?,?)").bind(id, action, via, extra.detail ? String(extra.detail).slice(0, 300) : null));
  await db.batch(stmts);

  const after = await db.prepare(LATEST).bind(id).first();
  return { ok: true, status: after.status, replied: !!after.replied_at, label: statusLabel(after.status, after), name: after.name };
}

// The hidden copy of an email the founder sent: which prospect was it to? Tries, in order, the exact
// address we found on their site, an address on their website's domain (or a subdomain of it), then the
// drafted subject line (for an address typed in by hand, like a Gmail address).
export async function matchSentCopy(db, addrs, subject) {
  for (const a of addrs) {
    const labels = a.split("@")[1].split(".");
    const domains = [];
    for (let i = 0; i <= labels.length - 2; i++) domains.push(labels.slice(i).join("."));
    const row = await db.prepare(
      `SELECT o.prospect_id FROM outreach o JOIN prospects p ON p.id = o.prospect_id
        WHERE lower(o.contact_email) = ? OR p.domain IN (${domains.map(() => "?").join(",")})
        ORDER BY o.id DESC LIMIT 1`,
    ).bind(a, ...domains).first();
    if (row) return { prospectId: row.prospect_id, to: a };
  }
  const s = String(subject || "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
  if (s) {
    const row = await db.prepare("SELECT prospect_id FROM outreach WHERE draft_subject = ? ORDER BY id DESC LIMIT 1").bind(s).first();
    if (row) return { prospectId: row.prospect_id, to: addrs[0] || null };
  }
  return null;
}
