'use strict';

/** Pool-health alerting: threshold → admin notification + support email, throttled + crash-safe. */

jest.mock('../models/QuizQuestion', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/Notification', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../services/agreement/emailService', () => ({ isConfigured: jest.fn(() => true), sendMail: jest.fn(async () => ({ ok: true })) }));

const QuizQuestion = require('../models/QuizQuestion');
const Notification = require('../models/Notification');
const email = require('../services/agreement/emailService');
const svc = require('../services/quizPoolAlertService');

beforeEach(() => {
  jest.clearAllMocks();
  svc._resetThrottle();
  process.env.QUIZ_ALERT_EMAIL = 'support@test.com';
  email.isConfigured.mockReturnValue(true);
});

test('remaining <= threshold → admin notification + support email', async () => {
  QuizQuestion.countDocuments.mockResolvedValue(3);
  await svc.maybeAlertLowPool('te', ['seen1']);
  expect(Notification.create).toHaveBeenCalledTimes(1);
  expect(Notification.create.mock.calls[0][0]).toMatchObject({ type: 'admin', sentBy: 'system' });
  expect(email.sendMail).toHaveBeenCalledTimes(1);
  expect(email.sendMail.mock.calls[0][0].to).toBe('support@test.com');
});

test('healthy pool (remaining > threshold) → no alert', async () => {
  QuizQuestion.countDocuments.mockResolvedValue(50);
  await svc.maybeAlertLowPool('te', []);
  expect(Notification.create).not.toHaveBeenCalled();
  expect(email.sendMail).not.toHaveBeenCalled();
});

test('throttled: the count is not repeated within the window', async () => {
  QuizQuestion.countDocuments.mockResolvedValue(2);
  await svc.maybeAlertLowPool('te', []);
  await svc.maybeAlertLowPool('te', []); // second hit is throttled
  expect(QuizQuestion.countDocuments).toHaveBeenCalledTimes(1);
  expect(Notification.create).toHaveBeenCalledTimes(1);
});

test('no recipient / SMTP down → notification still raised, email skipped', async () => {
  QuizQuestion.countDocuments.mockResolvedValue(0);
  delete process.env.QUIZ_ALERT_EMAIL;
  delete process.env.SUPPORT_EMAIL;
  await svc.maybeAlertLowPool('hi', []);
  expect(Notification.create).toHaveBeenCalledTimes(1); // urgent admin notif
  expect(Notification.create.mock.calls[0][0].priority).toBe('urgent'); // 0 left
  expect(email.sendMail).not.toHaveBeenCalled();
});

test('never throws even if the DB count fails (gameplay is never affected)', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  QuizQuestion.countDocuments.mockRejectedValue(new Error('db down'));
  await expect(svc.maybeAlertLowPool('te', [])).resolves.toBeUndefined();
  spy.mockRestore();
});
