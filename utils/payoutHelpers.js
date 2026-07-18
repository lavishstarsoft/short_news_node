/**
 * Payout method helpers for reporter wallet withdrawals.
 */

const MAX_PAYOUT_METHODS = 3;

const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_REGEX = /^\d{9,18}$/;

function serializePayoutMethod(m) {
  if (!m) return null;
  const obj = typeof m.toObject === 'function' ? m.toObject() : m;
  return {
    id: String(obj._id),
    type: obj.type,
    label: obj.label || (obj.type === 'upi' ? 'UPI' : 'Bank'),
    upiId: obj.upiId || '',
    accountHolderName: obj.accountHolderName || '',
    accountNumber: obj.accountNumber || '',
    // Mask account number for list display (last 4)
    accountNumberMasked: obj.accountNumber
      ? `${'*'.repeat(Math.max(0, String(obj.accountNumber).length - 4))}${String(obj.accountNumber).slice(-4)}`
      : '',
    ifsc: obj.ifsc || '',
    bankName: obj.bankName || '',
    isDefault: !!obj.isDefault,
    createdAt: obj.createdAt || null,
    displayText: formatPayoutMethodText(obj)
  };
}

function formatPayoutMethodText(m) {
  if (!m) return '';
  if (m.type === 'upi') {
    const label = m.label ? `${m.label}: ` : 'UPI: ';
    return `${label}${m.upiId}`;
  }
  const parts = [
    m.accountHolderName,
    `A/C ${m.accountNumber}`,
    `IFSC ${m.ifsc}`,
    m.bankName || null
  ].filter(Boolean);
  const label = m.label ? `${m.label} — ` : 'Bank — ';
  return label + parts.join(' · ');
}

function validatePayoutPayload(body) {
  const type = String(body.type || '').toLowerCase();
  if (type !== 'upi' && type !== 'bank') {
    return { error: 'Choose UPI or Bank account' };
  }

  const label = String(body.label || '').trim().slice(0, 40);

  if (type === 'upi') {
    const upiId = String(body.upiId || '').trim().toLowerCase();
    if (!UPI_REGEX.test(upiId)) {
      return { error: 'Enter a valid UPI ID (example: name@ybl)' };
    }
    return {
      data: {
        type: 'upi',
        label: label || 'UPI',
        upiId,
        accountHolderName: '',
        accountNumber: '',
        ifsc: '',
        bankName: ''
      }
    };
  }

  const accountHolderName = String(body.accountHolderName || '').trim();
  const accountNumber = String(body.accountNumber || '').replace(/\s/g, '');
  const ifsc = String(body.ifsc || '').trim().toUpperCase();
  const bankName = String(body.bankName || '').trim();

  if (accountHolderName.length < 2) {
    return { error: 'Enter account holder name' };
  }
  if (!ACCOUNT_REGEX.test(accountNumber)) {
    return { error: 'Enter a valid bank account number (9–18 digits)' };
  }
  if (!IFSC_REGEX.test(ifsc)) {
    return { error: 'Enter a valid IFSC code (example: SBIN0001234)' };
  }

  return {
    data: {
      type: 'bank',
      label: label || bankName || 'Bank',
      upiId: '',
      accountHolderName,
      accountNumber,
      ifsc,
      bankName
    }
  };
}

function ensureSingleDefault(methods, preferredId = null) {
  if (!methods.length) return;
  let found = false;
  for (const m of methods) {
    if (preferredId && String(m._id) === String(preferredId)) {
      m.isDefault = true;
      found = true;
    } else if (!preferredId && m.isDefault && !found) {
      found = true;
    } else {
      m.isDefault = false;
    }
  }
  if (!found) {
    methods[0].isDefault = true;
  }
}

module.exports = {
  MAX_PAYOUT_METHODS,
  serializePayoutMethod,
  formatPayoutMethodText,
  validatePayoutPayload,
  ensureSingleDefault
};
