import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  extractCafe,
  extractOrderId,
  isConfirmationSubject,
  normalize,
  parseMessage,
} from '../src/parse.js';
import {
  FOOD_ONLY,
  PERIOD_REDEMPTIONS,
  PICKUP_NOTICE,
  asMessage,
  flatBody,
  tableBody,
} from './fixtures/emails.js';

test('every verified confirmation in the period parses as a redemption', () => {
  const parsed = PERIOD_REDEMPTIONS.map((f) => parseMessage(asMessage(f)));
  assert.equal(parsed.filter(Boolean).length, 6, 'Phase 0 gate: the count is 6');

  assert.deepEqual(
    parsed.map((p) => p.orderId),
    PERIOD_REDEMPTIONS.map((f) => f.orderId),
  );
});

test('parsing is identical for plain-text and HTML-derived bodies', () => {
  for (const fixture of PERIOD_REDEMPTIONS) {
    const fromTable = parseMessage(asMessage(fixture, tableBody));
    const fromFlat = parseMessage(asMessage(fixture, flatBody));
    assert.deepEqual(fromFlat, fromTable, `body shapes disagree for ${fixture.orderId}`);
  }
});

test('order numbers come off the ORDER SUMMARY line', () => {
  // The shape the spec assumed, /Order\s*#(\d+)/, does not match this line;
  // "SUMMARY:" sits between the word and the hash.
  assert.equal(extractOrderId('| ORDER SUMMARY: #9000000000000006 |'), '9000000000000006');
  assert.equal(extractOrderId('ORDER SUMMARY:#9000000000000006'), '9000000000000006');
  assert.equal(extractOrderId('no order here'), null);
});

test('the pickup notice is rejected on subject alone', () => {
  assert.equal(isConfirmationSubject(PICKUP_NOTICE.subject), false);
  assert.equal(parseMessage(PICKUP_NOTICE), null);
});

test('confirmation subjects match across order types and apostrophe styles', () => {
  assert.ok(isConfirmationSubject("We've received your Rapid Pick-Up order, Sam!"));
  assert.ok(isConfirmationSubject("We've received your Drive-Thru Pick-Up order, Sam!"));
  assert.ok(isConfirmationSubject('We’ve received your Rapid Pick-Up order, Sam!'));
});

test('a food-only order is not a redemption', () => {
  assert.equal(parseMessage(FOOD_ONLY), null);
});

test('occurred_at is normalized to UTC from the message date', () => {
  const parsed = parseMessage({
    ...asMessage(PERIOD_REDEMPTIONS[0]),
    date: 'Tue, 11 Aug 2026 15:24:31 -0700',
  });
  assert.equal(parsed.occurredAt, '2026-08-11T22:24:31Z');
});

test('cafe is taken from the fulfilling store line', () => {
  const parsed = parseMessage(asMessage(PERIOD_REDEMPTIONS[0]));
  assert.equal(parsed.cafe, '1200 Example Ave Springfield, IL 62704');
});

test('cafe falls back to the store number when no address is present', () => {
  assert.equal(extractCafe('| CAFE #900001 |'), 'CAFE #900001');
  assert.equal(extractCafe('nothing useful'), null);
});

test('a drink-plus-food order still counts once', () => {
  const mixed = PERIOD_REDEMPTIONS[1];
  const parsed = parseMessage(asMessage(mixed));
  assert.equal(parsed.orderId, mixed.orderId);
  assert.equal(parsed.savingsAmount, 5.18);
  assert.equal(parsed.needsReview, false, 'a comped drink is present');
});

test('savings with nothing comped is counted but flagged for review', () => {
  // Hypothetical: a Sip Club discount applied to food with no free drink.
  // Counting it keeps the number from running silently low; the flag is what
  // surfaces it for reconciliation.
  const body = [
    '| ORDER SUMMARY: #9000000000000008 |',
    '| Asiago Bagel | $1.00 $2.19 |',
    '| Subtotal | $2.19 |',
    '| Sip Club Savings | -$1.19 |',
    '| Order Total | $1.00 |',
  ].join('\n');
  const verdict = classify(normalize(body));
  assert.equal(verdict.isRedemption, true);
  assert.equal(verdict.compedItem, false);
  assert.equal(verdict.needsReview, true);
});

test('normalize strips the template padding that would break matching', () => {
  const padded = 'Sip­Club';
  assert.equal(normalize(padded), 'SipClub');
  assert.equal(normalize('a  ​ b'), 'a b');
});

test('a confirmation with no order number is dropped rather than guessed at', () => {
  const body = tableBody({
    orderId: '1',
    item: 'Diet Pepsi',
    price: '3.99',
    savings: '3.99',
    total: '0.00',
    cafe: 'x',
  }).replace(/ORDER SUMMARY: #1/, 'ORDER SUMMARY:');
  assert.equal(
    parseMessage({ subject: "We've received your order, Sam!", date: '2026-08-15T16:01:55Z', body }),
    null,
  );
});
