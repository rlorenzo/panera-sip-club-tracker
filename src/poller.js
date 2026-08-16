import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { openDb, makeStore } from './db.js';
import { cycleFor } from './cycle.js';
import { isConfirmationSubject, parseMessage } from './parse.js';
import { buildStatus } from './status.js';
import { maybeAlert } from './alerts.js';

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

/**
 * Pull confirmations from the mailbox and upsert them.
 *
 * IMAP SEARCH is only used for the two criteria servers implement
 * consistently — sender and date. Subject and body matching happen here,
 * because phrase matching on body text is unreliable across servers and the
 * subject line carries a typographic apostrophe that encodes differently
 * depending on the server's charset handling.
 */
export async function pollOnce(store, opts = {}) {
  const now = opts.now ?? Date.now();
  const cycle = cycleFor(opts.anchorDate ?? config.anchorDate, now);
  const imapConfig = opts.imap ?? config.imap;

  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: true,
    auth: { user: imapConfig.user, pass: imapConfig.pass },
    logger: false,
  });

  const stats = { seen: 0, subjectMatched: 0, redemptions: 0, inserted: 0, skipped: 0, review: 0 };
  const rows = [];

  // connect() and getMailboxLock() live inside the try: if the lock fails
  // after a successful connect, an outside-the-try acquisition would skip the
  // finally and leak the IMAP connection until the server times it out.
  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock(imapConfig.mailbox);
    const uids = await client.search(
      { from: opts.sender ?? config.sender, since: cycle.start },
      { uid: true },
    );
    stats.seen = uids.length;

    if (uids.length) {
      const candidates = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        if (isConfirmationSubject(msg.envelope?.subject ?? '')) candidates.push(msg.uid);
      }
      stats.subjectMatched = candidates.length;

      if (candidates.length) {
        for await (const msg of client.fetch(
          candidates,
          { uid: true, source: true },
          { uid: true },
        )) {
          const mail = await simpleParser(msg.source);
          const parsed = parseMessage({
            subject: mail.subject,
            // Passed through unchanged. Substituting the poll time here would
            // defeat the parser's date check and file a message with no usable
            // timestamp into whatever period happens to be current.
            date: mail.date,
            // Prefer the real text/plain part; fall back to the HTML-derived
            // text mailparser synthesizes when the part is absent.
            body: mail.text || mail.html || '',
          });

          if (!parsed) {
            stats.skipped += 1;
            continue;
          }
          stats.redemptions += 1;
          if (parsed.needsReview) {
            stats.review += 1;
            // Sip Club Savings applied with no fully comped line item. Counted,
            // but worth reconciling against the app's order history.
            log('review_needed', {
              orderId: parsed.orderId,
              savings: parsed.savingsAmount,
              occurredAt: parsed.occurredAt,
            });
          }
          rows.push({
            orderId: parsed.orderId,
            occurredAt: parsed.occurredAt,
            cafe: parsed.cafe,
            source: 'email',
            needsReview: parsed.needsReview,
          });
          store.setMeta('last_uid', String(msg.uid));
        }
      }
    }
  } finally {
    lock?.release();
    await client.logout().catch(() => {});
  }

  stats.inserted = store.insertMany(rows);
  store.setMeta('last_poll_at', new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  return stats;
}

async function main() {
  const store = makeStore(openDb(config.dbPath));
  try {
    const stats = await pollOnce(store);
    log('poll_complete', stats);

    const status = buildStatus(store, config.anchorDate);
    log('status', { used: status.used, remaining: status.remaining, level: status.level });

    const sent = await maybeAlert(store, status);
    if (sent.length) log('alerts_sent', { sent });
  } catch (err) {
    log('poll_failed', { error: err.message });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
