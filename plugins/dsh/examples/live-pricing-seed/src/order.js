import { percentOf } from './money.js';

export function orderTotal(items, { couponPercent = 0, shippingCents = 0 } = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  const beforeDiscount = subtotal + shippingCents;
  return beforeDiscount - percentOf(beforeDiscount, couponPercent);
}
