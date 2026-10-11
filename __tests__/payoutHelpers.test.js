'use strict';

const { validatePayoutPayload, formatPayoutMethodText, serializePayoutMethod } = require('../utils/payoutHelpers');

describe('payout methods — UPI, PhonePe, Bank', () => {
  test('a valid PhonePe number is accepted and normalised to 10 digits', () => {
    const r = validatePayoutPayload({ type: 'phonepe', phoneNumber: '+91 98765-43210', label: 'My PhonePe' });
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ type: 'phonepe', phoneNumber: '9876543210', label: 'My PhonePe', upiId: '', accountNumber: '' });
  });

  test('a bad PhonePe number is rejected', () => {
    expect(validatePayoutPayload({ type: 'phonepe', phoneNumber: '12345' }).error).toMatch(/valid 10-digit/);
    expect(validatePayoutPayload({ type: 'phonepe', phoneNumber: '1234567890' }).error).toMatch(/valid 10-digit/); // must start 6-9
  });

  test('PhonePe display text and label', () => {
    expect(formatPayoutMethodText({ type: 'phonepe', phoneNumber: '9876543210' })).toBe('PhonePe: 9876543210');
    const s = serializePayoutMethod({ _id: 'x', type: 'phonepe', phoneNumber: '9876543210' });
    expect(s.label).toBe('PhonePe');
    expect(s.phoneNumberMasked).toBe('******3210');
    expect(s.displayText).toBe('PhonePe: 9876543210');
  });

  test('UPI and Bank still work and carry an (empty) phoneNumber field', () => {
    expect(validatePayoutPayload({ type: 'upi', upiId: 'ravi@ybl' }).data).toMatchObject({ type: 'upi', phoneNumber: '' });
    expect(validatePayoutPayload({ type: 'bank', accountHolderName: 'Ravi K', accountNumber: '123456789012', ifsc: 'SBIN0001234' }).data)
      .toMatchObject({ type: 'bank', phoneNumber: '', accountNumber: '123456789012' });
  });

  test('an unknown type is refused', () => {
    expect(validatePayoutPayload({ type: 'paytm' }).error).toMatch(/UPI, PhonePe or Bank/);
  });
});
