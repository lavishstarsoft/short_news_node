'use strict';

/**
 * Disjoint-set (Union-Find) for clustering similar article edges.
 */
function createUnionFind(ids = []) {
  const parent = new Map();
  const rank = new Map();

  for (const id of ids) {
    const key = String(id);
    parent.set(key, key);
    rank.set(key, 0);
  }

  function find(id) {
    const key = String(id);
    if (!parent.has(key)) {
      parent.set(key, key);
      rank.set(key, 0);
    }
    let root = key;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    let cur = key;
    while (cur !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    const rankA = rank.get(ra) || 0;
    const rankB = rank.get(rb) || 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
      return rb;
    }
    if (rankA > rankB) {
      parent.set(rb, ra);
      return ra;
    }
    parent.set(rb, ra);
    rank.set(ra, rankA + 1);
    return ra;
  }

  function components() {
    const map = new Map();
    for (const id of parent.keys()) {
      const root = find(id);
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(id);
    }
    return [...map.values()];
  }

  return { find, union, components };
}

module.exports = {
  createUnionFind,
};
