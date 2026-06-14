// Verify the DataLoader batches multiple author lookups into ONE query and
// preserves input order (the core N+1 fix).
const mockFind = jest.fn();
jest.mock('../models/Admin', () => ({
  find: (...args) => mockFind(...args),
}));
jest.mock('mongoose', () => ({
  Types: { ObjectId: { isValid: () => true } },
}));

const { createLoaders } = require('../graphql/loaders');

describe('graphql DataLoader (adminById)', () => {
  afterEach(() => mockFind.mockReset());

  test('batches multiple loads into a single Admin.find call', async () => {
    mockFind.mockResolvedValue([
      { _id: 'a1', name: 'Alice' },
      { _id: 'a2', name: 'Bob' },
    ]);

    const { adminById } = createLoaders();
    const [first, second] = await Promise.all([
      adminById.load('a1'),
      adminById.load('a2'),
    ]);

    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(first.name).toBe('Alice');
    expect(second.name).toBe('Bob');
  });

  test('returns null for ids that have no matching admin', async () => {
    mockFind.mockResolvedValue([{ _id: 'a1', name: 'Alice' }]);

    const { adminById } = createLoaders();
    const result = await adminById.load('missing-id');

    expect(result).toBeNull();
  });
});
