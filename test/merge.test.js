'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { merge } = require('../src/merge.js');

test('merge combines object keys, incoming values winning', () => {
  assert.deepEqual(merge({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 3, c: 4 });
});

test('merge recurses into nested objects', () => {
  const result = merge(
    { a: { b: 1, keep: 'x' }, top: 1 },
    { a: { b: 2, added: 'y' }, other: 3 }
  );
  assert.deepEqual(result, { a: { b: 2, keep: 'x', added: 'y' }, top: 1, other: 3 });
});

test('merge does not mutate either input', () => {
  const base = { a: { b: 1 }, list: [1] };
  const incoming = { a: { c: 2 }, list: [2] };
  const baseBefore = structuredClone(base);
  const incomingBefore = structuredClone(incoming);

  merge(base, incoming, { arrayPolicy: 'concat' });

  assert.deepEqual(base, baseBefore);
  assert.deepEqual(incoming, incomingBefore);
});

test('arrays are replaced by default', () => {
  assert.deepEqual(merge({ list: [1, 2, 3] }, { list: [9] }), { list: [9] });
});

test('arrayPolicy concat appends incoming after base', () => {
  assert.deepEqual(
    merge({ list: [1, 2] }, { list: [3, 4] }, { arrayPolicy: 'concat' }),
    { list: [1, 2, 3, 4] }
  );
});

test('arrayPolicy union appends only structurally new entries', () => {
  assert.deepEqual(
    merge({ list: [1, 2] }, { list: [2, 3] }, { arrayPolicy: 'union' }),
    { list: [1, 2, 3] }
  );
});

test('arrayPolicy union compares objects structurally', () => {
  const result = merge(
    { items: [{ id: 1, name: 'a' }] },
    { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] },
    { arrayPolicy: 'union' }
  );
  assert.deepEqual(result, { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
});

test('arrayPolicy union does not dedupe within the incoming array twice', () => {
  // The base is copied verbatim; union only suppresses entries already present.
  const result = merge({}, { list: ['x', 'x', 'y'] }, { arrayPolicy: 'union' });
  assert.deepEqual(result, { list: ['x', 'x', 'y'] });

  const deduped = merge({ list: ['x'] }, { list: ['x', 'y'] }, { arrayPolicy: 'union' });
  assert.deepEqual(deduped, { list: ['x', 'y'] });
});

test('arrays of different lengths combine correctly under concat', () => {
  assert.deepEqual(merge({ l: [] }, { l: [1] }, { arrayPolicy: 'concat' }), { l: [1] });
  assert.deepEqual(merge({ l: [1] }, { l: [] }, { arrayPolicy: 'concat' }), { l: [1] });
  assert.deepEqual(merge({}, { l: [1, 2] }, { arrayPolicy: 'concat' }), { l: [1, 2] });
});

test('an incoming null overwrites by default', () => {
  assert.deepEqual(merge({ a: 1 }, { a: null }), { a: null });
});

test('nullPolicy ignore keeps the base value', () => {
  assert.deepEqual(merge({ a: 1, b: 2 }, { a: null }, { nullPolicy: 'ignore' }), { a: 1, b: 2 });
  assert.deepEqual(merge({ a: { deep: 1 } }, { a: null }, { nullPolicy: 'ignore' }), { a: { deep: 1 } });
});

test('nullPolicy keep is an alias of ignore', () => {
  assert.deepEqual(merge({ a: 1 }, { a: null }, { nullPolicy: 'keep' }), { a: 1 });
});

test('a null in the base is replaced by an incoming value', () => {
  assert.deepEqual(merge({ a: null }, { a: { x: 1 } }), { a: { x: 1 } });
});

test('onConflict reports each policy-resolved value with its pointer', () => {
  const conflicts = [];
  merge(
    { list: [1], nested: { flag: true } },
    { list: [2], nested: { flag: null } },
    {
      arrayPolicy: 'concat',
      onConflict: (conflict) => conflicts.push(conflict),
    }
  );
  // Nested keys are visited in sorted order, so "/list" is reported first.
  assert.deepEqual(conflicts.map((c) => [c.kind, c.path]), [
    ['array', '/list'],
    ['null', '/nested/flag'],
  ]);
  assert.equal(conflicts[0].resolution, 'concat');
  assert.equal(conflicts[1].resolution, 'overwrite');
});

test('onConflict is not called for ordinary object recursion', () => {
  const conflicts = [];
  merge({ a: { b: 1 } }, { a: { c: 2 } }, { onConflict: (c) => conflicts.push(c) });
  assert.deepEqual(conflicts, []);
});

test('scalars and type changes take the incoming value', () => {
  assert.deepEqual(merge({ a: 1 }, { a: 'one' }), { a: 'one' });
  assert.deepEqual(merge({ a: { deep: true } }, { a: 5 }), { a: 5 });
  assert.deepEqual(merge({ a: 5 }, { a: { deep: true } }), { a: { deep: true } });
});

test('merging into a non-object replaces it wholesale', () => {
  assert.deepEqual(merge([1, 2], { a: 1 }), { a: 1 });
  assert.deepEqual(merge('text', 5), 5);
  assert.deepEqual(merge(null, { a: 1 }), { a: 1 });
});

test('unknown policies are rejected', () => {
  assert.throws(() => merge({}, {}, { arrayPolicy: 'shuffle' }), TypeError);
  assert.throws(() => merge({}, {}, { arrayPolicy: 'shuffle' }), /arrayPolicy must be one of/);
  assert.throws(() => merge({}, {}, { nullPolicy: 'keepit' }), /nullPolicy must be one of/);
});

test('keys containing / and ~ are escaped in conflict pointers', () => {
  const conflicts = [];
  merge({ 'a/b': [1] }, { 'a/b': [2] }, { onConflict: (c) => conflicts.push(c) });
  assert.equal(conflicts[0].path, '/a~1b');
});

test('a realistic overlay merge keeps untouched branches intact', () => {
  const base = {
    service: 'api',
    replicas: 2,
    resources: { cpu: '500m', memory: '512Mi' },
    env: [{ name: 'LOG_LEVEL', value: 'info' }],
  };
  const overlay = {
    replicas: 5,
    resources: { memory: '1Gi' },
    env: [{ name: 'REGION', value: 'eu' }],
  };

  assert.deepEqual(merge(base, overlay), {
    service: 'api',
    replicas: 5,
    resources: { cpu: '500m', memory: '1Gi' },
    env: [{ name: 'REGION', value: 'eu' }],
  });

  assert.deepEqual(merge(base, overlay, { arrayPolicy: 'concat' }), {
    service: 'api',
    replicas: 5,
    resources: { cpu: '500m', memory: '1Gi' },
    env: [{ name: 'LOG_LEVEL', value: 'info' }, { name: 'REGION', value: 'eu' }],
  });
});