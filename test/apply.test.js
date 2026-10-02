'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPatch, validateOperations } = require('../src/apply.js');
const { diff, deepEqual } = require('../src/diff.js');

test('applyPatch applies add, replace and remove operations', () => {
  const doc = { a: 1, b: 'x' };
  const result = applyPatch(doc, [
    { op: 'replace', path: '/a', value: 2 },
    { op: 'add', path: '/c', value: true },
    { op: 'remove', path: '/b' },
  ]);
  assert.deepEqual(result, { a: 2, c: true });
});

test('applyPatch leaves the input document untouched by default', () => {
  const doc = { a: 1, nested: { list: [1, 2] } };
  const before = structuredClone(doc);
  applyPatch(doc, [
    { op: 'replace', path: '/a', value: 99 },
    { op: 'add', path: '/nested/list/-', value: 3 },
    { op: 'remove', path: '/nested/list/0' },
  ]);
  assert.deepEqual(doc, before, 'the caller document must not be mutated');
});

test('applyPatch with inPlace mutates the supplied document', () => {
  const doc = { a: 1 };
  const result = applyPatch(doc, [{ op: 'replace', path: '/a', value: 2 }], { inPlace: true });
  assert.equal(result, doc);
  assert.deepEqual(doc, { a: 2 });
});

test('applyPatch deep-copies inserted values so they cannot alias', () => {
  const source = { nested: 1 };
  const result = applyPatch({}, [{ op: 'add', path: '/slot', value: source }]);
  source.nested = 99;
  assert.deepEqual(result.slot, { nested: 1 });
});

test('add splices into arrays while replace overwrites in place', () => {
  const doc = { list: [1, 2, 3] };
  const result = applyPatch(doc, [{ op: 'add', path: '/list/1', value: 99 }]);
  assert.deepEqual(result.list, [1, 99, 2, 3], 'add shifts later elements right');

  const replaced = applyPatch(doc, [{ op: 'replace', path: '/list/1', value: 99 }]);
  assert.deepEqual(replaced.list, [1, 99, 3], 'replace overwrites without shifting');
});

test('add supports the - token to append', () => {
  const result = applyPatch({ list: [1] }, [{ op: 'add', path: '/list/-', value: 2 }]);
  assert.deepEqual(result.list, [1, 2]);
});

test('an empty operation list returns an equal copy', () => {
  const doc = { a: 1 };
  const result = applyPatch(doc, []);
  assert.deepEqual(result, doc);
  assert.notEqual(result, doc, 'still a copy, not the same reference');
});

test('applyPatch replaces the whole document with the empty pointer', () => {
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }]), { b: 2 });
  assert.equal(applyPatch({ a: 1 }, [{ op: 'add', path: '', value: 7 }]), 7);
});

test('remove on a missing path throws a descriptive error', () => {
  assert.throws(
    () => applyPatch({ a: 1 }, [{ op: 'remove', path: '/missing' }]),
    /operation 0 \(remove \/missing\): cannot remove .*: key does not exist/
  );
  // A path whose parent is a scalar is reported as such, not as "missing".
  assert.throws(
    () => applyPatch({ a: 1 }, [{ op: 'remove', path: '/a/deeper' }]),
    /operation 0 \(remove \/a\/deeper\): cannot remove .*: parent is number, not a container/
  );
});

test('replace on a missing path throws a descriptive error', () => {
  assert.throws(
    () => applyPatch({ a: 1 }, [{ op: 'replace', path: '/missing', value: 2 }]),
    /operation 0 \(replace \/missing\): cannot replace .*: path does not exist/
  );
});

test('remove on an out-of-range array index throws', () => {
  assert.throws(
    () => applyPatch({ list: [1] }, [{ op: 'remove', path: '/list/5' }]),
    /out of range/
  );
});

test('remove at the root pointer is rejected', () => {
  assert.throws(
    () => applyPatch({ a: 1 }, [{ op: 'remove', path: '' }]),
    /a patch cannot delete the root document/
  );
});

test('errors carry the failing operation index and operation object', () => {
  try {
    applyPatch({ a: 1, b: 2 }, [
      { op: 'replace', path: '/a', value: 5 },
      { op: 'remove', path: '/nope' },
    ]);
    assert.fail('expected a throw');
  } catch (error) {
    assert.match(error.message, /operation 1/);
    assert.equal(error.operationIndex, 1);
    assert.deepEqual(error.operation, { op: 'remove', path: '/nope' });
  }
});

test('malformed operation lists are rejected', () => {
  assert.throws(() => applyPatch({}, 'not-an-array'), TypeError);
  assert.throws(() => applyPatch({}, [null]), TypeError);
  assert.throws(() => applyPatch({}, [[]]), TypeError);
  assert.throws(() => applyPatch({}, [{ op: 'delete', path: '/a' }]), /unknown op/);
  assert.throws(() => applyPatch({}, [{ op: 'add', path: 42, value: 1 }]), /path must be a string/);
  assert.throws(() => applyPatch({}, [{ op: 'add', path: '/a' }]), /requires a value/);
  assert.throws(() => applyPatch({}, [{ op: 'replace', path: '/a~9b', value: 1 }]), SyntaxError);
});

test('a patch that fails late does not partially mutate the input', () => {
  const doc = { a: 1, b: 2 };
  const before = structuredClone(doc);
  assert.throws(() => applyPatch(doc, [
    { op: 'replace', path: '/a', value: 99 },
    { op: 'remove', path: '/missing' },
  ]));
  assert.deepEqual(doc, before, 'validation happens before any mutation');
});

test('validateOperations accepts a well-formed patch', () => {
  assert.doesNotThrow(() => validateOperations([
    { op: 'add', path: '/a', value: 1 },
    { op: 'replace', path: '/b', value: 2 },
    { op: 'remove', path: '/c' },
  ]));
});

test('escaped pointers apply correctly', () => {
  const result = applyPatch({ 'a/b': 1, 'c~d': 2 }, [
    { op: 'replace', path: '/a~1b', value: 10 },
    { op: 'remove', path: '/c~0d' },
  ]);
  assert.deepEqual(result, { 'a/b': 10 });
});

test('diff output applies back to the right document, in index mode', () => {
  const before = {
    name: 'service',
    count: 1,
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    tags: ['x'],
    nested: { keep: true, drop: 1 },
  };
  const after = {
    name: 'service',
    count: 2,
    items: [{ id: 'a' }, { id: 'B' }],
    tags: ['x', 'y'],
    nested: { keep: false },
    added: 'new',
  };
  const ops = diff(before, after, { arrayMode: 'index' });
  assert.deepEqual(applyPatch(before, ops), after);
});

test('diff output applies back to the right document, in lcs mode', () => {
  const before = {
    name: 'service',
    count: 1,
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    tags: ['x'],
    nested: { keep: true, drop: 1 },
  };
  const after = {
    name: 'service',
    count: 2,
    items: [{ id: 'a' }, { id: 'B' }],
    tags: ['x', 'y'],
    nested: { keep: false },
    added: 'new',
  };
  const ops = diff(before, after, { arrayMode: 'lcs' });
  assert.deepEqual(applyPatch(before, ops), after);
});

test('apply then diff is stable: re-diffing yields no operations', () => {
  const before = { a: 1, list: [1, 2, 3], obj: { x: 'y' } };
  const after = { a: 5, list: [9, 1, 3], obj: { x: 'z', w: true } };
  for (const arrayMode of ['index', 'lcs']) {
    const patched = applyPatch(before, diff(before, after, { arrayMode }));
    assert.deepEqual(diff(patched, after, { arrayMode }), [], `${arrayMode} should converge`);
  }
});

test('a patch built without oldValue still applies', () => {
  const ops = diff({ a: 1, b: 2 }, { a: 9, c: 3 }, { includeOldValue: false });
  const result = applyPatch({ a: 1, b: 2 }, ops);
  assert.deepEqual(result, { a: 9, c: 3 });
});

test('applyPatch preserves deeply nested structures', () => {
  const doc = { a: { b: { c: { d: [1, { e: 'f' }] } } } };
  const result = applyPatch(doc, [{ op: 'replace', path: '/a/b/c/d/1/e', value: 'g' }]);
  assert.deepEqual(result, { a: { b: { c: { d: [1, { e: 'g' }] } } } });
  assert.equal(deepEqual(result.a.b.c.d[1], { e: 'g' }), true);
});