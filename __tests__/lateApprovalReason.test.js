'use strict';

/**
 * 30-minute / day-late reason layer: boundary classification, backend reason
 * validation (anti-gibberish), and idempotent immutable reason recording.
 */

jest.mock('../models/LateApprovalReason', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../utils/dailyRewardService', () => ({ evaluateDailyReward: jest.fn(() => Promise.resolve({ admin: { username: 'Rep' }, maxReward: 30, referenceId: 'reward_rep1_2026-08-09' })) }));
jest.mock('../models/Admin', () => ({ find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })) }));
jest.mock('../models/Notification', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve({})) }));
// Unrelated deps of the service module (loaded on require) — keep them inert.
jest.mock('../models/LateApprovalEarning', () => ({ findOne: jest.fn(), create: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(() => Promise.resolve(0)) }));
jest.mock('../utils/walletHelpers', () => ({ checkAndCreditWallet: jest.fn(), processWalletTransaction: jest.fn() }));

const LateApprovalReason = require('../models/LateApprovalReason');
const Notification = require('../models/Notification');
const svc = require('../services/earning/lateApprovalService');

// IST = UTC+5:30.
const submitAug9_10am = new Date('2026-08-13T04:30:00Z'); // 13 Aug 10:00 IST
const approve_29m = new Date('2026-08-13T04:59:00Z');      // +29 min
const approve_30m = new Date('2026-08-13T05:00:00Z');      // exactly +30:00
const approve_30m1s = new Date('2026-08-13T05:00:01Z');    // +30:01
const submit_1159pm = new Date('2026-08-09T18:29:00Z');    // 9 Aug 23:59 IST
const approve_1200am = new Date('2026-08-09T18:30:30Z');   // 10 Aug 00:00:30 IST (crosses day, <30 min)

describe('classifyLateness (boundary)', () => {
  test('29 minutes → on_time (normal approval)', () => {
    const c = svc.classifyLateness(submitAug9_10am, approve_29m);
    expect(c.type).toBe('on_time'); expect(c.late).toBe(false);
  });
  test('exactly 30:00 → on_time (documented boundary: <=30:00 allowed)', () => {
    const c = svc.classifyLateness(submitAug9_10am, approve_30m);
    expect(c.type).toBe('on_time'); expect(c.late).toBe(false);
  });
  test('30 min + 1 second → same_day_late (reason required)', () => {
    const c = svc.classifyLateness(submitAug9_10am, approve_30m1s);
    expect(c.type).toBe('same_day_late'); expect(c.late).toBe(true);
  });
  test('crossing midnight (even under 30 min) → day_late', () => {
    const c = svc.classifyLateness(submit_1159pm, approve_1200am);
    expect(c.type).toBe('day_late'); expect(c.late).toBe(true); expect(c.dayLate).toBe(true);
  });
});

describe('isValidReason (backend anti-gibberish)', () => {
  test.each([
    ['', false],
    ['ok', false],
    ['busy', false],
    ['too short', false],
    ['aaaaaaaaaaaaaaaaaa', false],
    ['asdf asdf asdf asdf', false],
    ['busy busy busy busy busy', false],
    ['Reporter uploaded the news very late so I could not verify it earlier today', true],
    ['నేను రాత్రి ఆలస్యంగా చూశాను అందుకే ఆమోదం ఆలస్యం అయింది', true],
  ])('reason "%s" → %s', (text, expected) => {
    expect(svc.isValidReason(text)).toBe(expected);
  });
});

describe('recordLateApprovalReason (idempotent + immutable + notifications)', () => {
  const news = { _id: 'news1', title: 'Flood update', authorId: 'rep1' };
  const approver = { id: 'ic1', name: 'Ashraf', role: 'subeditor' };
  beforeEach(() => {
    jest.clearAllMocks();
    LateApprovalReason.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    LateApprovalReason.create.mockImplementation((d) => Promise.resolve({ _id: 'lar1', ...d }));
  });

  test('same_day_late → records reason + warns In-Charge + Super Admin', async () => {
    const r = await svc.recordLateApprovalReason({ news, approver, submittedAt: submitAug9_10am, attemptAt: approve_30m1s, approvedAt: approve_30m1s, type: 'same_day_late', reason: 'Reporter posted late and I was travelling so verification took time' });
    expect(r.recorded).toBe(true);
    expect(r.earningStatus).toBe('auto_credited');
    const created = LateApprovalReason.create.mock.calls[0][0];
    expect(created.lateApprovalType).toBe('same_day_late');
    expect(created.lateApprovalReason).toMatch(/travelling/);
    expect(Notification.create).toHaveBeenCalled(); // in-charge + super admin
  });

  test('day_late → records reason as pending, NO duplicate notification here', async () => {
    const r = await svc.recordLateApprovalReason({ news, approver, submittedAt: submit_1159pm, attemptAt: approve_1200am, approvedAt: approve_1200am, type: 'day_late', reason: 'Approved after midnight because the news came in very late at night' });
    expect(r.recorded).toBe(true);
    expect(r.earningStatus).toBe('pending_superadmin_review');
    expect(Notification.create).not.toHaveBeenCalled(); // handled by handleApprovalEarning
  });

  test('duplicate (same newsId already recorded) → no second record', async () => {
    LateApprovalReason.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'lar1', newsId: 'news1' }) });
    const r = await svc.recordLateApprovalReason({ news, approver, submittedAt: submit_1159pm, attemptAt: approve_1200am, approvedAt: approve_1200am, type: 'day_late', reason: 'Approved after midnight because the news came in very late at night' });
    expect(r.recorded).toBe(false);
    expect(LateApprovalReason.create).not.toHaveBeenCalled();
  });
});
