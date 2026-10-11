'use strict';

jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));

const { mergeDoc, normHotspots, toPublic } = require('../controllers/trainPromoBannerController');

describe('train promo banner — sanitize / merge', () => {
  test('null doc → disabled, empty', () => {
    expect(mergeDoc(null)).toEqual({
      enabled: false, imageUrl: '', aspectRatio: 0, title: '', subtitle: '', linkUrl: '', hotspots: [],
    });
  });

  test('fields trimmed/capped; aspectRatio kept only when > 0', () => {
    const m = mergeDoc({
      enabled: true, imageUrl: '  /b.jpg  ', aspectRatio: 2.8,
      title: 'T'.repeat(300), subtitle: 'S', linkUrl: ' app://train ',
    });
    expect(m.enabled).toBe(true);
    expect(m.imageUrl).toBe('/b.jpg');
    expect(m.aspectRatio).toBe(2.8);
    expect(m.title.length).toBe(160);
    expect(m.linkUrl).toBe('app://train');
    expect(mergeDoc({ aspectRatio: 0 }).aspectRatio).toBe(0);
    expect(mergeDoc({ aspectRatio: -1 }).aspectRatio).toBe(0);
  });
});

describe('train promo banner — hotspots', () => {
  test('valid hotspots kept; too-small or link-less dropped; coords clamped; capped at 12', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ x: 0, y: 0, w: 0.3, h: 0.3, linkUrl: 'https://n' + i }));
    const hs = normHotspots([
      { x: 0.1, y: 0.1, w: 0.3, h: 0.2, linkUrl: 'https://one' }, // ok
      { x: 0.5, y: 0.5, w: 0.01, h: 0.2, linkUrl: 'https://tiny' }, // too small → dropped
      { x: 0.2, y: 0.2, w: 0.3, h: 0.3, linkUrl: '' }, // no link → dropped
      { x: 0.8, y: 0.1, w: 0.5, h: 0.2, linkUrl: 'app://quiz' }, // x+w>1 → w clamped to 0.2
    ]);
    expect(hs.map((h) => h.linkUrl)).toEqual(['https://one', 'app://quiz']);
    expect(hs[1].w).toBeCloseTo(0.2, 5);
    expect(normHotspots(many).length).toBe(12); // MAX_HOTSPOTS
    expect(normHotspots('nope')).toEqual([]);
  });

  test('mergeDoc normalizes its hotspots too', () => {
    const m = mergeDoc({ hotspots: [
      { x: 0.1, y: 0.1, w: 0.3, h: 0.2, linkUrl: 'app://games', label: 'note' },
      { x: 0, y: 0, w: 0, h: 0, linkUrl: 'https://z' }, // zero size → dropped
    ] });
    expect(m.hotspots.length).toBe(1);
    expect(m.hotspots[0].linkUrl).toBe('app://games');
    expect(m.hotspots[0].label).toBe('note'); // label kept internally...
  });
});

describe('train promo banner — public payload', () => {
  test('disabled → { enabled:false }', () => {
    expect(toPublic(mergeDoc({ enabled: false, imageUrl: '/b.jpg' }))).toEqual({ success: true, enabled: false });
  });

  test('enabled but no image → { enabled:false }', () => {
    expect(toPublic(mergeDoc({ enabled: true, imageUrl: '' }))).toEqual({ success: true, enabled: false });
  });

  test('enabled + image → full payload with label stripped from hotspots', () => {
    const content = mergeDoc({
      enabled: true, imageUrl: '/b.jpg', aspectRatio: 1.6, title: 'Hi', subtitle: 'Sub', linkUrl: 'app://train',
      hotspots: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, linkUrl: 'app://quiz', label: 'secret' }],
    });
    const pub = toPublic(content);
    expect(pub).toMatchObject({ success: true, enabled: true, imageUrl: '/b.jpg', aspectRatio: 1.6, title: 'Hi', subtitle: 'Sub', linkUrl: 'app://train' });
    expect(pub.hotspots).toEqual([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, linkUrl: 'app://quiz' }]); // label stripped
  });
});
