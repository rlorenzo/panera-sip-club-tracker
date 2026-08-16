# Phase 0 — source verification

**Status: gate passed, with two parser corrections.**
Verified 2026-08-16 against the live mailbox for the period starting 2026-08-11.

The gate was: pull "We've received" messages since 2026-08-11, confirm the
`Sip Club Savings` match, confirm the count is **6**, confirm order numbers
extract cleanly.

## Result

Six confirmation emails in the period, all six matching as redemptions, all six
with unique parseable order numbers. **Count = 6, as expected.**

| # | `occurred_at` (UTC) | `order_id` | Item | Savings | Order total |
|---|---|---|---|---|---|
| 1 | 2026-08-11T22:24:31Z | 9000000000000001 | Diet Pepsi | -$3.99 | $0.00 |
| 2 | 2026-08-13T15:29:08Z | 9000000000000002 | Diet Pepsi + Asiago Bagel | -$5.18 | $1.00 |
| 3 | 2026-08-13T22:23:02Z | 9000000000000003 | Cafe Blend Iced Coffee | -$4.79 | $0.00 |
| 4 | 2026-08-14T15:20:31Z | 9000000000000004 | Hot Tea | -$3.39 | $0.00 |
| 5 | 2026-08-14T22:17:10Z | 9000000000000005 | Cafe Blend Iced Coffee | -$4.79 | $0.00 |
| 6 | 2026-08-15T16:01:55Z | 9000000000000006 | Diet Pepsi | -$3.99 | $0.00 |

All six were fulfilled at cafe #900001 (1200 Example Ave, Springfield IL), via a mix of
Rapid Pick-Up and Drive-Thru.

## Corrections the real mail forced

### 1. The order-number regex in the spec never matches

The spec proposed `/Order\s*#\s*(\d+)/i`. The actual line is:

```
ORDER SUMMARY: #9000000000000006
```

`SUMMARY:` sits between the word and the hash, so `\s*` cannot bridge it. The
spec's pattern matches **zero** of six emails. Had this shipped as written, the
poller would have parsed every message, found the savings line, failed to
extract an ID, and silently recorded nothing — the count would have sat at 0
forever while the logs showed messages being processed.

Corrected to `/ORDER\s+SUMMARY\s*:?\s*#\s*(\d+)/i`, with a
`/\bOrder\s*(?:#|No\.?|Number)\s*:?\s*(\d{6,})/i` fallback in case the template
drops the word.

Order numbers are 16 digits and increase monotonically with time, so they work
as both a dedupe key and a rough ordering.

### 2. `Sip Club Savings` is an order-level discount, not a drink-only one

Order #2 above is a drink *and* a bagel: `Sip Club Savings | -$5.18`, which is
$3.99 (the drink) plus $1.19 (off the $2.19 bagel). So the savings line proves a
Sip Club benefit was applied — it does **not** prove a drink was redeemed, and
its amount cannot be compared against a drink price.

This leaves a theoretical false positive: a food-only order that still draws a
Sip Club discount would be counted as a drink redemption. The parser therefore
also looks for a fully comped line item (`$0.00` beside a struck-through price)
and reports it as a `needsReview` signal.

That signal deliberately **does not** gate the count. A drink carrying a size or
add-in upcharge could bill above $0.00, and gating on `$0.00` would drop it —
producing a silently low count, which is the worse failure. Per the project's own
kill criteria, a count that reads low produces confident wrong answers at the
register. So: count it, flag it, log it, reconcile it. The poller emits a
`review_needed` log line for any such message.

The spec's rule (savings line present) remains the decision. It matched all six.

### 3. Body formatting is not guaranteed

Bodies were read here through a converter that renders the HTML part as a
markdown-ish table, so lines arrive as `| Sip Club Savings | -$3.99 |`. A real
`text/plain` MIME part fetched over IMAP may be spaced differently or absent.

The parser normalizes both shapes before matching — invisible template padding
stripped, whitespace collapsed, optional pipes tolerated — and the test suite
asserts that a table-shaped body and a flat-text body of the same order produce
byte-identical parse output. Run `npm run probe` against the real mailbox to
confirm before trusting the count in production.

## Incidental findings

- **Every order really does generate two emails**, as the spec said: a
  "We've received your … order, Sam!" confirmation and a "Woo! 🎉 Your … order is
  READY!" pickup notice, typically 40–90 seconds apart. Only the confirmation is
  ingested, filtered on subject.
- **Even if a pickup notice leaked through, it would be harmless.** It carries
  the same order number, so `ON CONFLICT DO NOTHING` collapses it into the
  existing row. Dedupe by `order_id` protects the count from subject-filter
  drift.
- **Gmail threads the two confirmations of different days together** when their
  subjects are identical, so a thread-oriented view undercounts. Message-level
  IMAP iteration, which is what the poller does, is unaffected.
- **Subjects vary by fulfilment type** — "Rapid Pick-Up" and "Drive-Thru
  Pick-Up" both appear — so the subject test matches only the invariant
  "We've received your" prefix, and tolerates a curly apostrophe.

## Still open

1. **Do kiosk and in-cafe scan redemptions email at all?** Not resolved: every
   order in this window was placed through the app (Rapid Pick-Up or
   Drive-Thru). Nothing here shows what an in-cafe scan does. This is the
   accuracy claim's remaining risk, and the manual-entry path stays load-bearing
   until it is settled. Cross-check a full week against the app's order history.
2. **Does the count match Panera's own accounting?** Six emails is six emails;
   whether Panera counts the same six against the cap is unverified until the
   cap goes live on 2026-08-19.
3. **Refunds and cancellations.** Not observed in this window. Unknown whether a
   cancelled order emits a confirmation that stays counted.

## Re-running the gate

```sh
IMAP_USER=… IMAP_PASSWORD=… npm run probe -- --since 2026-08-11 --expect 6
```

Exits non-zero if order numbers fail to parse, duplicate, or the count misses
`--expect`. Re-run it whenever Panera changes their template — the parse
failures it catches are exactly the ones that would otherwise show up as a
count that quietly stops moving.
