import { percentOf } from './money.js';

export function orderTotal(items, { couponPercent = 0, shippingCents = 0 } = {}) {
  if (couponPercent < 0 || couponPercent > 100) {
    throw new RangeError('couponPercent must be between 0 and 100');
  }
  const subtotal = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  const discount = percentOf(subtotal, couponPercent);
  return subtotal - discount + shippingCents;
}
