// Panera order-confirmation parsing.
//
// Regexes here were verified against six real confirmation emails from the
// 2026-08-11 period; see docs/phase0-verification.md. Two things that the
// original spec got wrong and that the real mail corrected:
//
//   1. The order number lives on an "ORDER SUMMARY: #<digits>" line. A
//      `/Order\s*#\s*(\d+)/` pattern does not match it — "SUMMARY:" sits
//      between the word and the hash.
//   2. "Sip Club Savings" is an order-level discount that can cover food as
//      well as the drink (one verified order discounted a bagel under the same
//      label), so its amount is not a drink-only signal.

/** Invisible padding Panera's template injects between glyphs. */
const INVISIBLE = /[­​-‏⁠͏﻿]/g;

/**
 * Fold a body into a stable shape for matching.
 *
 * Bodies reach us either as a real text/plain MIME part or as HTML converted
 * to text, and the two differ in whitespace and table pipes. Normalizing both
 * to single-spaced lines lets one set of regexes serve either.
 */
export function normalize(body) {
  if (!body) return '';
  return body
    .replace(INVISIBLE, '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
}

// "Sip Club Savings | -$3.99" and "Sip Club Savings  -$5.18" both match.
const SIP_SAVINGS = /Sip\s+Club\s+Savings\s*\|?\s*-\s*\$(\d+\.\d{2})/i;

// "ORDER SUMMARY: #9000000000000006". The second alternative is a hedge for a
// template that drops the "SUMMARY" word; it is not seen in current mail.
const ORDER_ID = /ORDER\s+SUMMARY\s*:?\s*#\s*(\d+)/i;
const ORDER_ID_FALLBACK = /\bOrder\s*(?:#|No\.?|Number)\s*:?\s*(\d{6,})/i;

// A line item shown as free with its original price struck through:
// "Diet Pepsi | $0.00 $3.99".
const COMPED_ITEM = /\$0\.00\s*\|?\s*\$\d+\.\d{2}/;

const CAFE_NUMBER = /CAFE\s*#\s*(\d+)/i;
// The house number must be followed by a word, or the match happily starts on
// the store number or a phone number sitting earlier on the same line.
const STREET_ADDRESS = /(\d{1,6}\s+[A-Za-z][A-Za-z0-9.'\- ]{2,40}?,\s*[A-Z]{2}\s+\d{5})/;
const PHONE = /\+?\d{3}[-.\s]\d{3}[-.\s]\d{4}/g;
const EMPTY_LINK = /\[\]\([^)]*\)/g;

/** True when the subject is the order confirmation, not the pickup notice. */
export function isConfirmationSubject(subject = '') {
  return /We['’]ve\s+received\s+your\b/i.test(subject);
}

export function extractOrderId(text) {
  const m = text.match(ORDER_ID) ?? text.match(ORDER_ID_FALLBACK);
  return m ? m[1] : null;
}

export function extractCafe(text) {
  // Prefer the address on the "CAFE #nnnnnn" footer line so we get the store
  // that fulfilled the order rather than any address in boilerplate.
  const cafeLine = text
    .split('\n')
    .find((line) => CAFE_NUMBER.test(line));

  // Strip the store number, phone numbers and link artifacts so only the
  // postal address is left to match against.
  const scrub = (s) => s.replace(EMPTY_LINK, ' ').replace(CAFE_NUMBER, ' ').replace(PHONE, ' ');

  const addr = (
    (cafeLine && scrub(cafeLine).match(STREET_ADDRESS)) ??
    scrub(text).match(STREET_ADDRESS)
  )?.[1];
  if (addr) return addr.replace(/\s+/g, ' ').trim();

  const num = text.match(CAFE_NUMBER)?.[1];
  return num ? `CAFE #${num}` : null;
}

/**
 * Decide whether a confirmation represents a Sip Club drink redemption.
 *
 * The presence of the Sip Club Savings line is the decision, matching the
 * spec. `compedItem` is reported alongside but deliberately does NOT gate the
 * result: a drink carrying a size or add-in upcharge could bill above $0.00,
 * and undercounting is the worse failure — a silently low count produces
 * confident wrong answers at the register. When the two signals disagree the
 * caller logs it for reconciliation instead of dropping the row.
 */
export function classify(text) {
  const savings = text.match(SIP_SAVINGS);
  const compedItem = COMPED_ITEM.test(text);
  return {
    isRedemption: Boolean(savings),
    savingsAmount: savings ? Number(savings[1]) : null,
    compedItem,
    // Savings applied with nothing fully comped: possibly a food-only
    // discount that should not count against the drink cap.
    needsReview: Boolean(savings) && !compedItem,
  };
}

/**
 * Parse one message into a redemption row, or null if it is not one.
 *
 * @param {{subject?: string, date: Date|string, body: string}} msg
 */
export function parseMessage(msg) {
  if (!isConfirmationSubject(msg.subject ?? '')) return null;

  const text = normalize(msg.body);
  const verdict = classify(text);
  if (!verdict.isRedemption) return null;

  const orderId = extractOrderId(text);
  if (!orderId) return null;

  const occurredAt = new Date(msg.date);
  if (Number.isNaN(occurredAt.getTime())) return null;

  return {
    orderId,
    occurredAt: occurredAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    cafe: extractCafe(text),
    needsReview: verdict.needsReview,
    savingsAmount: verdict.savingsAmount,
  };
}
