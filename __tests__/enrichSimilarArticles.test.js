'use strict';

const {
  resolveNewsId,
  enrichSimilarArticlesFromDb,
} = require('../services/aiDuplicate/enrichSimilarArticles');

describe('enrichSimilarArticlesFromDb', () => {
  test('resolveNewsId strips media_id suffix', () => {
    expect(resolveNewsId('507f1f77bcf86cd799439011:https://cdn.example/a.jpg')).toBe(
      '507f1f77bcf86cd799439011'
    );
    expect(resolveNewsId('507f1f77bcf86cd799439011')).toBe(
      '507f1f77bcf86cd799439011'
    );
  });

  test('fills blank title/content from News', async () => {
    const id = '507f1f77bcf86cd799439011';
    const News = {
      find: jest.fn(() => ({
        select: () => ({
          lean: async () => [
            {
              _id: id,
              title: 'Flood in city',
              content: 'Full story body here',
              author: 'Reporter A',
              category: 'News',
              location: 'AP',
              publishedAt: new Date('2026-07-01'),
              isActive: false,
              mediaUrl: 'https://cdn.example/a.jpg',
              mediaType: 'image',
              thumbnailUrl: 'https://cdn.example/a.jpg',
              language: 'te',
            },
          ],
        }),
      })),
    };

    const out = await enrichSimilarArticlesFromDb(
      [
        {
          articleId: `${id}:https://cdn.example/a.jpg`,
          articleTitle: '',
          content: '',
          matchSource: 'image',
          similarity: { title: 0, content: 0, keywords: 0, overall: 100 },
        },
      ],
      { News }
    );

    expect(out[0].articleId).toBe(id);
    expect(out[0].articleTitle).toBe('Flood in city');
    expect(out[0].content).toBe('Full story body here');
    expect(out[0].author).toBe('Reporter A');
    expect(out[0].mediaUrl).toBe('https://cdn.example/a.jpg');
  });
});
