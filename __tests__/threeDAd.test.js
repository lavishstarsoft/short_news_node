'use strict';
const ctrl = require('../controllers/threeDAdController');
const { sanitize } = ctrl._test;

describe('ThreeDAd sanitize — safe, bounded input', () => {
  test('bad target/style fall back to safe defaults', () => {
    const s = sanitize({ title: ' Hi ', imageUrl: ' u ', targetType: 'xxx', rotateStyle: 'zzz' });
    expect(s.title).toBe('Hi');
    expect(s.imageUrl).toBe('u');
    expect(s.targetType).toBe('quiz');
    expect(s.rotateStyle).toBe('spin');
  });
  test('speed is clamped to 2..30', () => {
    expect(sanitize({ speedSeconds: '99' }).speedSeconds).toBe(30);
    expect(sanitize({ speedSeconds: '1' }).speedSeconds).toBe(2);
    expect(sanitize({ speedSeconds: 'x' }).speedSeconds).toBe(6);
  });
  test('targetValue kept ONLY for url/news; dropped for route types', () => {
    expect(sanitize({ targetType: 'url', targetValue: 'https://a' }).targetValue).toBe('https://a');
    expect(sanitize({ targetType: 'news', targetValue: 'n1' }).targetValue).toBe('n1');
    expect(sanitize({ targetType: 'quiz', targetValue: 'leak' }).targetValue).toBe('');
  });
  test('language lowercased; isActive coerced', () => {
    const s = sanitize({ language: 'TE', isActive: 'true' });
    expect(s.language).toBe('te');
    expect(s.isActive).toBe(true);
    expect(sanitize({ isActive: 'false' }).isActive).toBe(false);
  });
});
