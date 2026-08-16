// Structural fixtures derived from six real confirmation emails in the
// 2026-08-11 period. Tracking URLs, click IDs and marketing boilerplate are
// stripped: only the lines the parser reads are kept.
//
// `tableBody` reproduces the shape seen when the HTML part is converted to
// text (pipes, invisible padding). `flatBody` reproduces a plain text/plain
// part. The parser must handle both, since which one arrives depends on what
// the mail server hands back.

const INVISIBLE = '­͏﻿';

export function tableBody({ orderId, item, price, savings, total, cafe, cafeNo = '606336' }) {
  return [
    'Panera',
    '| |',
    '| Your order is in the works. |',
    `${INVISIBLE} ${INVISIBLE}  ${INVISIBLE}`,
    '| Your order for Rapid Pick-Up will be ready at: |',
    `| ${INVISIBLE}09:04 AM |`,
    `| ${INVISIBLE}08/15/2026 |`,
    '| |',
    `| | ${cafe} |`,
    `| | ${INVISIBLE}909-703-2591[](909-703-2591) |`,
    '| RAPID PICK-UP INSTRUCTIONS Your order contains a self-serve drink. |',
    '| |',
    `| ORDER SUMMARY: #${orderId} |`,
    `| 1 item • $${total} • Rapid Pick-Up |`,
    '| |',
    `| ${item} | $0.00 $${price} |`,
    '| Qty: 1 |',
    '| |',
    `| Subtotal | $${price} |`,
    `| Sip Club Savings | -$${savings} |`,
    `| Order Total | $${total} |`,
    '| |',
    `| CAFE #${cafeNo} 909-703-2591[](909-703-2591) ${cafe} |`,
    '| Panera Bread 1400 South Highway Drive, Suite 100, Fenton, MO 63026 |',
  ].join('\n');
}

export function flatBody({ orderId, item, price, savings, total, cafe, cafeNo = '606336' }) {
  return [
    'Your order is in the works.',
    '',
    'Your order for Rapid Pick-Up will be ready at:',
    '09:04 AM',
    '08/15/2026',
    '',
    cafe,
    '909-703-2591',
    '',
    `ORDER SUMMARY: #${orderId}`,
    `1 item • $${total} • Rapid Pick-Up`,
    '',
    `${item}   $0.00   $${price}`,
    'Qty: 1',
    '',
    `Subtotal      $${price}`,
    `Sip Club Savings   -$${savings}`,
    `Order Total   $${total}`,
    '',
    `CAFE #${cafeNo}  909-703-2591  ${cafe}`,
  ].join('\n');
}

const CHINO = '8391 Pine Ave Chino, CA 91708';

/** The six verified redemptions of the 2026-08-11 period, in order. */
export const PERIOD_REDEMPTIONS = [
  {
    subject: "We've received your Rapid Pick-Up order, Rex!",
    date: '2026-08-11T22:24:31Z',
    orderId: '6051716151604995',
    item: 'Diet Pepsi',
    price: '3.99',
    savings: '3.99',
    total: '0.00',
    cafe: CHINO,
  },
  {
    // Drink plus a discounted bagel: savings exceed the drink price, which is
    // why the savings amount cannot be used as a drink-only signal.
    subject: "We've received your Rapid Pick-Up order, Rex!",
    date: '2026-08-13T15:29:08Z',
    orderId: '6051716152358773',
    item: 'Diet Pepsi',
    price: '3.99',
    savings: '5.18',
    total: '1.00',
    cafe: CHINO,
  },
  {
    subject: "We've received your Rapid Pick-Up order, Rex!",
    date: '2026-08-13T22:23:02Z',
    orderId: '6051716152641852',
    item: 'Cafe Blend Iced Coffee',
    price: '4.79',
    savings: '4.79',
    total: '0.00',
    cafe: CHINO,
  },
  {
    subject: "We've received your Drive-Thru Pick-Up order, Rex!",
    date: '2026-08-14T15:20:31Z',
    orderId: '6051716152875314',
    item: 'Hot Tea',
    price: '3.39',
    savings: '3.39',
    total: '0.00',
    cafe: CHINO,
  },
  {
    subject: "We've received your Drive-Thru Pick-Up order, Rex!",
    date: '2026-08-14T22:17:10Z',
    orderId: '6051716153149333',
    item: 'Cafe Blend Iced Coffee',
    price: '4.79',
    savings: '4.79',
    total: '0.00',
    cafe: CHINO,
  },
  {
    subject: "We've received your Rapid Pick-Up order, Rex!",
    date: '2026-08-15T16:01:55Z',
    orderId: '6051716153357744',
    item: 'Diet Pepsi',
    price: '3.99',
    savings: '3.99',
    total: '0.00',
    cafe: CHINO,
  },
];

/** The pickup notice that follows every order and must never be counted. */
export const PICKUP_NOTICE = {
  subject: 'Woo! 🎉 Your Rapid Pick-Up order is READY!',
  date: '2026-08-15T16:01:56Z',
  body: tableBody({
    orderId: '6051716153357744',
    item: 'Diet Pepsi',
    price: '3.99',
    savings: '3.99',
    total: '0.00',
    cafe: CHINO,
  }),
};

/** A food-only order: no Sip Club line at all, so it is not a redemption. */
export const FOOD_ONLY = {
  subject: "We've received your Rapid Pick-Up order, Rex!",
  date: '2026-08-12T18:02:00Z',
  body: [
    '| ORDER SUMMARY: #6051716151999001 |',
    '| Asiago Bagel | $2.19 |',
    '| Subtotal | $2.19 |',
    '| Order Total | $2.19 |',
    `| CAFE #606336 909-703-2591 ${CHINO} |`,
  ].join('\n'),
};

export function asMessage(fixture, shape = tableBody) {
  return {
    subject: fixture.subject,
    date: fixture.date,
    body: fixture.body ?? shape(fixture),
  };
}
