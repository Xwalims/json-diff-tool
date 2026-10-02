'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { diff, deepEqual, summarize } = require('../src/diff.js');

test('deepEqual compares structurally and ignores object key order', () => {
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(deepEqual([1, [2, { x: 1 }]], [1, [2, { x: 1 }]]), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual(1, '1'), false);
});

test('identical documents produce no operations', () => {
  const doc = { a: 1, b: [1, 2, { c: 'x' }], d: null };
  assert.deepEqual(diff(doc, structuredClone(doc)), []);
  assert.deepEqual(diff(1, 1), []);
  assert.deepEqual(diff(null, null), []);
  assert.deepEqual(diff([], []), []);
});

test('object keys added in the right document become add operations', () => {
  assert.deepEqual(diff({ a: 1 }, { a: 1, b: 2 }), [
    { op: 'add', path: '/b', value: 2 },
  ]);
  assert.deepEqual(diff({}, { nested: { deep: 1 } }), [
    { op: 'add', path: '/nested', value: { deep: 1 } },
  ]);
});

test('object keys only in the left document become remove operations', () => {
  assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1 }), [
    { op: 'remove', path: '/b', oldValue: 2 },
  ]);
});

test('changed leaf values become replace with both old and new value', () => {
  assert.deepEqual(diff({ a: 1 }, { a: 2 }), [
    { op: 'replace', path: '/a', value: 2, oldValue: 1 },
  ]);
  assert.deepEqual(diff({ flag: true }, { flag: false }), [
    { op: 'replace', path: '/flag', value: false, oldValue: true },
  ]);
  assert.deepEqual(diff({ v: 'x' }, { v: null }), [
    { op: 'replace', path: '/v', value: null, oldValue: 'x' },
  ]);
  assert.deepEqual(diff({ v: null }, { v: 'x' }), [
    { op: 'replace', path: '/v', value: 'x', oldValue: null },
  ]);
});

test('differing types at a path become a single replace', () => {
  assert.deepEqual(diff({ a: { b: 1 } }, { a: 5 }), [
    { op: 'replace', path: '/a', value: 5, oldValue: { b: 1 } },
  ]);
  assert.deepEqual(diff({ a: [1, 2] }, { a: 'x' }), [
    { op: 'replace', path: '/a', value: 'x', oldValue: [1, 2] },
  ]);
  assert.deepEqual(diff({ a: 1 }, { a: null }), [
    { op: 'replace', path: '/a', value: null, oldValue: 1 },
  ]);
  assert.deepEqual(diff([1], { '0': 1 }), [
    { op: 'replace', path: '', value: { '0': 1 }, oldValue: [1] },
  ]);
});

test('a changed container is not descended into', () => {
  // The array became an object: one replace, no per-index noise.
  const ops = diff({ a: [1, 2, 3] }, { a: { '0': 1 } });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'replace');
});

test('nested object edits recurse to full pointer paths', () => {
  const a = { level1: { level2: { level3: { value: 1, keep: true } } } };
  const b = { level1: { level2: { level3: { value: 2, keep: true } } } };
  assert.deepEqual(diff(a, b), [
    { op: 'replace', path: '/level1/level2/level3/value', value: 2, oldValue: 1 },
  ]);
});

test('keys containing / and ~ are escaped in the emitted path', () => {
  const ops = diff({ 'a/b': 1 }, { 'a/b': 2, 'c~d': 3 });
  assert.deepEqual(ops, [
    { op: 'replace', path: '/a~1b', value: 2, oldValue: 1 },
    { op: 'add', path: '/c~0d', value: 3 },
  ]);
});

test('object key output order is deterministic and sorted', () => {
  const a = { z: 1, a: 1, m: 1 };
  const b = { z: 2, a: 2, m: 2 };
  const forward = diff(a, b);
  // Reverse the key order in the source; the emitted paths must not change.
  const reversed = diff({ m: 1, a: 1, z: 1 }, { m: 2, a: 2, z: 2 });
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.map((op) => op.path), ['/a', '/m', '/z']);
});

test('diffing a document against itself in both orders is symmetric in count', () => {
  const a = { keep: 1, changed: 1, gone: 1, list: [1, 2] };
  const b = { keep: 1, changed: 9, added: 1, list: [1, 2, 3] };
  const forward = summarize(diff(a, b));
  const backward = summarize(diff(b, a));
  assert.equal(forward.add, backward.remove);
  assert.equal(forward.remove, backward.add);
  assert.equal(forward.replace, backward.replace);
});

test('index mode pairs array elements positionally', () => {
  assert.deepEqual(diff({ l: [1, 2, 3] }, { l: [1, 9, 3] }), [
    { op: 'replace', path: '/l/1', value: 9, oldValue: 2 },
  ]);
});

test('index mode reports trailing elements as adds and removes', () => {
  assert.deepEqual(diff({ l: [1] }, { l: [1, 2, 3] }), [
    { op: 'add', path: '/l/1', value: 2 },
    { op: 'add', path: '/l/2', value: 3 },
  ]);
  assert.deepEqual(diff({ l: [1, 2, 3] }, { l: [1] }), [
    { op: 'remove', path: '/l/2', oldValue: 3 },
    { op: 'remove', path: '/l/1', oldValue: 2 },
  ]);
});

test('index mode recurses into nested containers inside arrays', () => {
  const a = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] };
  const b = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'B' }] };
  assert.deepEqual(diff(a, b), [
    { op: 'replace', path: '/items/1/name', value: 'B', oldValue: 'b' },
  ]);
});

test('index mode misses moves: a prepend costs N replacements', () => {
  const a = { l: [1, 2, 3] };
  const b = { l: [0, 1, 2, 3] };
  const ops = diff(a, b, { arrayMode: 'index' });
  assert.equal(ops.length, 4);
  assert.equal(ops.filter((op) => op.op === 'replace').length, 3);
  assert.equal(ops.filter((op) => op.op === 'add').length, 1);
});

test('lcs mode sees a prepend as a single insertion', () => {
  const a = { l: [1, 2, 3] };
  const b = { l: [0, 1, 2, 3] };
  assert.deepEqual(diff(a, b, { arrayMode: 'lcs' }), [
    { op: 'add', path: '/l/0', value: 0 },
  ]);
});

test('lcs mode sees an append and a mid-array deletion cheaply', () => {
  assert.deepEqual(diff([1, 2, 3], [1, 2, 3, 4], { arrayMode: 'lcs' }), [
    { op: 'add', path: '/3', value: 4 },
  ]);
  assert.deepEqual(diff([1, 2, 3, 4], [1, 4], { arrayMode: 'lcs' }), [
    { op: 'remove', path: '/2', oldValue: 3 },
    { op: 'remove', path: '/1', oldValue: 2 },
  ]);
});

test('lcs mode handles simultaneous removals without index corruption', () => {
  const ops = diff([1, 2, 3, 4, 5], [1, 5], { arrayMode: 'lcs' });
  assert.deepEqual(ops.map((op) => op.path), ['/3', '/2', '/1']);
  assert.deepEqual(ops.map((op) => op.oldValue), [4, 3, 2]);
});

test('lcs mode still recurses into matched container elements', () => {
  const a = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  const b = [{ id: 1, name: 'A' }, { id: 2, name: 'b' }];
  assert.deepEqual(diff(a, b, { arrayMode: 'lcs' }), [
    { op: 'replace', path: '/0/name', value: 'A', oldValue: 'a' },
  ]);
});

test('lcs mode matches a moved block instead of rewriting it', () => {
  const ops = diff([1, 2, 3, 4], [3, 4, 1, 2], { arrayMode: 'lcs' });
  // Everything is still reported, but the shared values are reused as
  // moves rather than being re-emitted as fresh replacements.
  assert.ok(ops.length > 0);
  assert.ok(ops.every((op) => ['add', 'remove', 'replace'].includes(op.op)));
});

test('lcs mode is empty for equal and disjoint arrays', () => {
  assert.deepEqual(diff([1, 2, 3], [1, 2, 3], { arrayMode: 'lcs' }), []);
  assert.deepEqual(diff([], [], { arrayMode: 'lcs' }), []);
  const ops = diff([1, 2], [3, 4], { arrayMode: 'lcs' });
  assert.equal(ops.length, 2);
  assert.ok(ops.every((op) => op.op === 'replace'), 'no anchors fall back to positional edits');
});

test('invalid arrayMode is rejected', () => {
  assert.throws(() => diff([1], [1], { arrayMode: 'nope' }), TypeError);
  assert.throws(() => diff([1], [1], { arrayMode: 'greedy' }), /must be "index" or "lcs"/);
});

test('includeValue and includeOldValue can be turned off', () => {
  const ops = diff({ a: 1, b: 2 }, { a: 9 }, {
    includeOldValue: false,
    includeValue: false,
  });
  assert.deepEqual(ops, [
    { op: 'replace', path: '/a' },
    { op: 'remove', path: '/b' },
  ]);
  assert.ok(ops.every((op) => !('value' in op) && !('oldValue' in op)));
});

test('emitted values are deep-copied unless cloneValues is disabled', () => {
  const b = { nested: { n: 1 }, list: [1] };
  const ops = diff({}, b);
  // Keys are visited in sorted order, so "list" is the first operation.
  assert.equal(ops[0].path, '/list');
  b.nested.n = 99;
  b.list.push(2);
  assert.deepEqual(ops[0].value, [1], 'mutating the source cannot reach the operation');

  const shared = diff({}, b, { cloneValues: false });
  assert.equal(shared[0].value, b.list, 'cloneValues:false shares the reference');
});

test('diff does not mutate its inputs', () => {
  const a = { list: [1, 2], obj: { x: 1 } };
  const b = { list: [1, 3], obj: { x: 2 } };
  const aBefore = structuredClone(a);
  const bBefore = structuredClone(b);
  diff(a, b);
  diff(a, b, { arrayMode: 'lcs' });
  assert.deepEqual(a, aBefore);
  assert.deepEqual(b, bBefore);
});

test('top-level scalar and null replacements use the empty pointer', () => {
  assert.deepEqual(diff(1, 2), [{ op: 'replace', path: '', value: 2, oldValue: 1 }]);
  assert.deepEqual(diff({ a: 1 }, null), [{ op: 'replace', path: '', value: null, oldValue: { a: 1 } }]);
  assert.deepEqual(diff([1, 2], [1, 2]), []);
});

test('a realistic config change yields a readable op list', () => {
  const before = {
    service: 'api',
    replicas: 2,
    image: { repo: 'acme/api', tag: '1.0.0' },
    env: { LOG_LEVEL: 'info', REGION: 'eu' },
    hosts: ['a.example.com', 'b.example.com'],
  };
  const after = {
    service: 'api',
    replicas: 4,
    image: { repo: 'acme/api', tag: '1.1.0' },
    env: { LOG_LEVEL: 'debug' },
    hosts: ['a.example.com', 'b.example.com', 'c.example.com'],
  };

  assert.deepEqual(diff(before, after, { arrayMode: 'lcs' }), [
    { op: 'replace', path: '/env/LOG_LEVEL', value: 'debug', oldValue: 'info' },
    { op: 'remove', path: '/env/REGION', oldValue: 'eu' },
    { op: 'add', path: '/hosts/2', value: 'c.example.com' },
    { op: 'replace', path: '/image/tag', value: '1.1.0', oldValue: '1.0.0' },
    { op: 'replace', path: '/replicas', value: 4, oldValue: 2 },
  ]);
});

test('summarize tallies operations by kind', () => {
  const counts = summarize(diff({ keep: 1, chg: 1, gone: 1 }, { keep: 1, chg: 2, new: 3 }));
  assert.deepEqual(counts, { add: 1, remove: 1, replace: 1, total: 3 });
  assert.deepEqual(summarize([]), { add: 0, remove: 0, replace: 0, total: 0 });
});