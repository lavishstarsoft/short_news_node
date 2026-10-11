'use strict';

const { mergeDoc, DEFAULTS } = require('../controllers/reporterAdvertiseController');

describe('reporter advertise page — content merge / sanitize', () => {
  test('null doc → complete built-in defaults for the language', () => {
    const te = mergeDoc(null, 'te');
    expect(te.language).toBe('te');
    expect(te.enabled).toBe(false);
    expect(te.banner.title).toBe(DEFAULTS.te.banner.title);
    expect(te.blocks.length).toBeGreaterThan(0);
    expect(te.blocks.find((b) => b.type === 'bullets').items.length).toBeGreaterThan(0);
    expect(te.cta.action).toBe('whatsapp');
  });

  test('unknown language falls back to English defaults', () => {
    const xx = mergeDoc(null, 'xx');
    expect(xx.banner.title).toBe(DEFAULTS.en.banner.title);
  });

  test('admin values override defaults; overlay side + block type are validated', () => {
    const merged = mergeDoc({
      enabled: true,
      banner: { imageUrl: 'https://cdn/b.jpg', title: 'Earn more', subtitle: 'with us', overlaySide: 'left' },
      blocks: [
        { type: 'heading', text: 'Share these' },
        { type: 'bullets', items: ['Shops', ' ', 'Hotels'] },
        { type: 'weird', text: 'kept as paragraph' },
      ],
      cta: { label: 'Join', action: 'url', value: 'https://x.com' },
    }, 'en');

    expect(merged.enabled).toBe(true);
    expect(merged.banner).toMatchObject({ imageUrl: 'https://cdn/b.jpg', title: 'Earn more', overlaySide: 'left' });
    expect(merged.blocks[0]).toMatchObject({ type: 'heading', text: 'Share these' });
    expect(merged.blocks[1].items).toEqual(['Shops', 'Hotels']); // blanks dropped
    expect(merged.blocks[2].type).toBe('paragraph'); // unknown type coerced
    expect(merged.cta).toMatchObject({ label: 'Join', action: 'url', value: 'https://x.com' });
  });

  test('invalid overlay side / cta action fall back to safe values', () => {
    const m = mergeDoc({ banner: { overlaySide: 'diagonal' }, cta: { action: 'sms' } }, 'en');
    expect(m.banner.overlaySide).toBe('right');
    expect(m.cta.action).toBe('none');
  });

  test('empty blocks are dropped, and an all-empty blocks list falls back to defaults', () => {
    const withEmpties = mergeDoc({ blocks: [{ type: 'paragraph', text: '' }, { type: 'bullets', items: [] }] }, 'en');
    expect(withEmpties.blocks).toEqual(DEFAULTS.en.blocks.map((b) => expect.objectContaining({ type: b.type })));
  });
});
