import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderTotal } from '../src/order.js';

test('coupon applies to goods and shipping is added afterward', () => {
  assert.equal(orderTotal([{ unitCents: 1250, quantity: 2 }], { couponPercent: 10, shippingCents: 300 }), 2550);
});
test('discount rounding occurs before adding shipping', () => {
  assert.equal(orderTotal([{ unitCents: 333, quantity: 3 }], { couponPercent: 15, shippingCents: 101 }), 950);
});
test('no coupon preserves the complete goods and shipping total', () => {
  assert.equal(orderTotal([{ unitCents: 1250, quantity: 2 }], { shippingCents: 300 }), 2800);
});
test('a full discount still charges shipping', () => {
  assert.equal(orderTotal([{ unitCents: 800, quantity: 2 }], { couponPercent: 100, shippingCents: 200 }), 200);
});
test('invalid coupon percentages are rejected', () => {
  for (const couponPercent of [-1, 101]) {
    assert.throws(() => orderTotal([{ unitCents: 1000, quantity: 1 }], { couponPercent }), RangeError);
  }
});
