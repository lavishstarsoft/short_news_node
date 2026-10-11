'use strict';

jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));
jest.mock('../services/viewDistribution/displayViews', () => ({ displayViews: (n) => (n && n.views) || 0 }));

const { mergeDoc, normCard, resolveCards, toAppNews, toAppAd } = require('../controllers/specialDeckController');

const NEWS_ID = 'a1b2c3d4e5f60718293a4b5c';
const AD_ID = 'ffffffffffffffffffffffff';

describe('special deck — sanitize / merge', () => {
  test('null doc → disabled, no cards', () => {
    expect(mergeDoc(null, 'te')).toEqual({ language: 'te', enabled: false, cards: [] });
  });

  test('unknown type coerces to banner; news/ad cards without a valid id are dropped', () => {
    const m = mergeDoc({
      enabled: true,
      cards: [
        { type: 'weird', title: 'x' },
        { type: 'news', newsId: 'not-an-objectid' },
        { type: 'news', newsId: NEWS_ID },
        { type: 'ad', adId: '' },
        { type: 'ad', adId: AD_ID },
        { type: 'quiz' },
        { type: 'train', title: 'Where is my train?' },
      ],
    }, 'te');
    expect(m.enabled).toBe(true);
    expect(m.cards.map((c) => c.type)).toEqual(['banner', 'news', 'ad', 'quiz', 'train']);
    expect(m.cards.map((c) => c.order)).toEqual([1, 2, 3, 4, 5]); // renumbered
  });

  test('cards are re-ordered by their order field; per-card enabled defaults true', () => {
    const m = mergeDoc({ cards: [{ order: 3, type: 'quiz' }, { order: 1, type: 'train' }, { order: 2, type: 'banner', enabled: false }] }, 'en');
    expect(m.cards.map((c) => c.type)).toEqual(['train', 'banner', 'quiz']);
    expect(m.cards.map((c) => c.enabled)).toEqual([true, false, true]);
  });

  test('normCard trims + caps strings and keeps ids only for the matching type', () => {
    const c = normCard({ type: 'news', newsId: NEWS_ID, adId: AD_ID, title: '  Hello  ', linkUrl: 'x'.repeat(700) });
    expect(c.newsId).toBe(NEWS_ID);
    expect(c.adId).toBe(''); // adId is meaningless on a news card
    expect(c.title).toBe('Hello');
    expect(c.linkUrl.length).toBe(600);
  });
});

describe('special deck — public resolution', () => {
  const news = { _id: NEWS_ID, title: 'Big story', content: 'body', thumbnailUrl: '/t.jpg', mediaUrl: '/m.jpg', language: 'te', views: 12, likes: 3, publishedAt: new Date('2026-09-20'), userInteractions: { likes: [{ userId: 'u1', userEmail: 'x@y.z' }], comments: [] } };
  const ad = { _id: AD_ID, title: 'Buy now', imageUrls: ['/a.jpg'], linkUrl: 'https://x', isActive: true, language: 'te' };
  const deps = {
    News: { find: jest.fn(() => ({ lean: async () => [news] })) },
    Ad: { find: jest.fn(() => ({ lean: async () => [ad] })) },
  };

  test('news/ad cards resolve to feed-shaped objects; disabled cards skipped; order preserved', async () => {
    const cards = mergeDoc({ cards: [
      { type: 'news', newsId: NEWS_ID },
      { type: 'quiz', title: 'Daily Quiz', enabled: false },
      { type: 'train', title: 'Where is my train?', subtitle: 'Live status' },
      { type: 'ad', adId: AD_ID },
      { type: 'banner', title: 'Offer', imageUrl: '/b.jpg', linkUrl: 'app://games' },
    ] }, 'te').cards;

    const out = await resolveCards(cards, deps);
    expect(out.map((c) => c.type)).toEqual(['news', 'train', 'ad', 'banner']);
    expect(out[0].news).toMatchObject({ id: NEWS_ID, title: 'Big story', imageUrl: '/t.jpg', mediaUrl: '/m.jpg', language: 'te', views: 12, likes: 3 });
    expect(out[0].news.userLikes[0]).toEqual({ userId: 'u1' }); // email stripped
    expect(out[1]).toMatchObject({ type: 'train', title: 'Where is my train?', subtitle: 'Live status' });
    expect(out[2].ad).toMatchObject({ id: AD_ID, title: 'Buy now', imageUrl: '/a.jpg', imageUrls: ['/a.jpg'], useAdMob: false });
    expect(out[3]).toMatchObject({ type: 'banner', title: 'Offer', imageUrl: '/b.jpg', linkUrl: 'app://games' });
    // Only active news / active non-AdMob ads are queried.
    expect(deps.News.find).toHaveBeenCalledWith({ _id: { $in: [NEWS_ID] }, isActive: { $ne: false } });
    expect(deps.Ad.find).toHaveBeenCalledWith({ _id: { $in: [AD_ID] }, isActive: true, useAdMob: { $ne: true } });
  });

  test('a news card whose story was deleted / deactivated is dropped (no hole in the deck)', async () => {
    const empty = { News: { find: () => ({ lean: async () => [] }) }, Ad: { find: () => ({ lean: async () => [] }) } };
    const cards = mergeDoc({ cards: [{ type: 'news', newsId: NEWS_ID }, { type: 'quiz' }] }, 'te').cards;
    const out = await resolveCards(cards, empty);
    expect(out.map((c) => c.type)).toEqual(['quiz']);
  });

  test('toAppNews / toAppAd fall back to the placeholder image', () => {
    expect(toAppNews({ _id: NEWS_ID, title: 't' }).imageUrl).toBe('/images/placeholder.png');
    expect(toAppAd({ _id: AD_ID, title: 'a' }).imageUrl).toBe('/images/placeholder.png');
  });
});

describe('special deck — banner hotspots', () => {
  test('valid hotspots are kept; too-small or link-less ones dropped; coords clamped', () => {
    const m = mergeDoc({ cards: [{
      type: 'banner', imageUrl: '/b.jpg', linkUrl: 'https://whole', aspectRatio: 1.9,
      hotspots: [
        { x: 0.1, y: 0.1, w: 0.3, h: 0.2, linkUrl: 'https://one' },   // ok
        { x: 0.5, y: 0.5, w: 0.01, h: 0.2, linkUrl: 'https://tiny' }, // too small → dropped
        { x: 0.2, y: 0.2, w: 0.3, h: 0.3, linkUrl: '' },              // no link → dropped
        { x: 0.8, y: 0.1, w: 0.5, h: 0.2, linkUrl: 'app://quiz' },    // x+w>1 → w clamped to 0.2
      ],
    }] }, 'te');
    const b = m.cards[0];
    expect(b.aspectRatio).toBe(1.9);
    expect(b.hotspots.map((h) => h.linkUrl)).toEqual(['https://one', 'app://quiz']);
    expect(b.hotspots[1].w).toBeCloseTo(0.2, 5); // clamped so x+w <= 1
  });

  test('hotspots/aspectRatio only exist on banner cards', () => {
    const m = mergeDoc({ cards: [
      { type: 'train', hotspots: [{ x: 0, y: 0, w: 0.5, h: 0.5, linkUrl: 'https://x' }], aspectRatio: 1.5 },
    ] }, 'te');
    expect(m.cards[0].hotspots).toEqual([]);
    expect(m.cards[0].aspectRatio).toBe(0);
  });

  test('resolveCards forwards hotspots + aspectRatio for banners', async () => {
    const cards = mergeDoc({ cards: [{
      type: 'banner', imageUrl: '/b.jpg', aspectRatio: 1.6,
      hotspots: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, linkUrl: 'app://train', label: 'note' }],
    }] }, 'te').cards;
    const out = await resolveCards(cards, {
      News: { find: () => ({ lean: async () => [] }) },
      Ad: { find: () => ({ lean: async () => [] }) },
    });
    expect(out[0]).toMatchObject({ type: 'banner', aspectRatio: 1.6 });
    expect(out[0].hotspots).toEqual([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, linkUrl: 'app://train' }]); // label stripped
  });
});
