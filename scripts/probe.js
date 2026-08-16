#!/usr/bin/env node
// Phase 0 gate. Reads the mailbox and prints what the parser sees, without
// touching the database. Run this before trusting any count downstream, and
// re-run it whenever Panera changes their email template.
//
//   IMAP_USER=... IMAP_PASSWORD=... npm run probe
//   npm run probe -- --since 2026-08-11

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../src/config.js';
import { cycleFor, isoDate } from '../src/cycle.js';
import { classify, isConfirmationSubject, normalize, parseMessage } from '../src/parse.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const cycle = cycleFor(config.anchorDate);
const since = flag('since') ? new Date(`${flag('since')}T00:00:00Z`) : cycle.start;

const client = new ImapFlow({
  host: config.imap.host,
  port: config.imap.port,
  secure: true,
  auth: { user: config.imap.user, pass: config.imap.pass },
  logger: false,
});

console.log(`anchor      ${config.anchorDate}`);
console.log(`period      ${isoDate(cycle.start)} → ${isoDate(cycle.end)} (day ${cycle.day})`);
console.log(`searching   FROM ${config.sender} SINCE ${isoDate(since)}\n`);

await client.connect();
const lock = await client.getMailboxLock(config.imap.mailbox);

const found = [];
let confirmations = 0;
let notices = 0;

try {
  const uids = await client.search({ from: config.sender, since }, { uid: true });
  console.log(`${uids.length} message(s) from ${config.sender}\n`);

  for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
    const mail = await simpleParser(msg.source);
    if (!isConfirmationSubject(mail.subject ?? '')) {
      notices += 1;
      continue;
    }
    confirmations += 1;

    const body = mail.text || mail.html || '';
    const verdict = classify(normalize(body));
    const parsed = parseMessage({ subject: mail.subject, date: mail.date, body });

    if (parsed) {
      found.push(parsed);
      console.log(
        `  ✓ ${parsed.occurredAt}  #${parsed.orderId}  -$${verdict.savingsAmount}` +
          `  ${parsed.cafe ?? '(no cafe)'}${parsed.needsReview ? '  [REVIEW: no comped item]' : ''}`,
      );
    } else {
      console.log(
        `  · ${mail.date?.toISOString()}  not a redemption` +
          `${verdict.isRedemption ? ' (savings found but order number did not parse)' : ''}`,
      );
    }
  }
} finally {
  lock.release();
  await client.logout().catch(() => {});
}

const inPeriod = found.filter(
  (r) => r.occurredAt >= cycle.start.toISOString() && r.occurredAt < cycle.endExclusive.toISOString(),
);
const unique = new Set(inPeriod.map((r) => r.orderId));

console.log(`\nconfirmations   ${confirmations}`);
console.log(`pickup notices  ${notices}  (ignored)`);
console.log(`redemptions     ${found.length}`);
console.log(`in period       ${inPeriod.length}  (${unique.size} unique order numbers)`);

if (unique.size !== inPeriod.length) {
  console.error('\nFAIL: duplicate order numbers — dedupe key is not unique.');
  process.exit(1);
}
if (found.some((r) => !/^\d+$/.test(r.orderId))) {
  console.error('\nFAIL: an order number did not parse cleanly.');
  process.exit(1);
}

const expected = flag('expect');
if (expected && Number(expected) !== inPeriod.length) {
  console.error(`\nFAIL: expected ${expected} redemptions in period, found ${inPeriod.length}.`);
  console.error('Fix the parser before building anything on top of this count.');
  process.exit(1);
}

console.log('\nGate: order numbers parse and dedupe cleanly.');
console.log('Cross-check the count above against the Panera app order history before trusting it.');
