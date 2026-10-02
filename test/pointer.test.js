'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeToken,
  unescapeToken,
  encodePointer,
  decodePointer,
  get,
  has,
  set,
  insert,
  remove,
  typeOf,
  toArrayIndex,
} = require('../src/pointer.js');

test('escapeToken escapes ~ before / per RFC 6901', () => {
  assert.equal(escapeToken('plain'), 'plain');
  assert.equal(escapeToken('a/b'), 'a~1b');
  assert.equal(escapeToken('m~n'), 'm~0n');
  assert.equal(escapeToken('~/'), '~0~1');
  // The literal sequence "~1" must not become "/".
  assert.equal(escapeToken('~1'), '~01');
});

test('unescapeToken reverses escapeToken, including ~01 -> ~1', () => {
  assert.equal(unescapeToken('a~1b'), 'a/b');
  assert.equal(unescapeToken('m~0n'), 'm~n');
  assert.equal(unescapeToken('~01'), '~1');
  assert.equal(unescapeToken('~01~1'), '~1/');
});

test('escapeToken and unescapeToken round-trip for hostile keys', () => {
  const keys = ['', '/', '~', '~0', '~1', 'a~/b~', 'ünïcødé', '0', 'with space'];
  for (const key of keys) {
    assert.equal(unescapeToken(escapeToken(key)), key);
  }
});

test('encodePointer joins tokens with slashes', () => {
  assert.equal(encodePointer([]), '');
  assert.equal(encodePointer(['a']), '/a');
  assert.equal(encodePointer(['a', 'b', 'c']), '/a/b/c');
  assert.equal(encodePointer(['a/b']), '/a~1b');
  assert.equal(encodePointer([0, 1]), '/0/1');
  assert.equal(encodePointer('single'), '/single');
});

test('decodePointer splits and unescapes tokens', () => {
  assert.deepEqual(decodePointer(''), []);
  assert.deepEqual(decodePointer('/'), ['']);
  assert.deepEqual(decodePointer('/a/b'), ['a', 'b']);
  assert.deepEqual(decodePointer('/a~1b/~0c'), ['a/b', '~c']);
});

test('decodePointer rejects malformed pointers and bad escapes', () => {
  assert.throws(() => decodePointer('a/b'), SyntaxError);
  assert.throws(() => decodePointer('/a~2b'), SyntaxError);
  assert.throws(() => decodePointer('/~'), SyntaxError);
  assert.throws(() => decodePointer(42), TypeError);
});

test('typeOf distinguishes null, arrays and plain objects', () => {
  assert.equal(typeOf(null), 'null');
  assert.equal(typeOf([]), 'array');
  assert.equal(typeOf({}), 'object');
  assert.equal(typeOf('x'), 'string');
  assert.equal(typeOf(1), 'number');
  assert.equal(typeOf(false), 'boolean');
  assert.equal(typeOf(undefined), 'undefined');
});

test('toArrayIndex only accepts canonical non-negative integers', () => {
  assert.equal(toArrayIndex('0'), 0);
  assert.equal(toArrayIndex('12'), 12);
  assert.equal(toArrayIndex('01'), null);
  assert.equal(toArrayIndex('-'), null);
  assert.equal(toArrayIndex('-1'), null);
  assert.equal(toArrayIndex('1.5'), null);
  assert.equal(toArrayIndex('name'), null);
});

test('get reads nested values by pointer', () => {
  const doc = { user: { name: 'Ada', tags: ['x', 'y'] }, '': 'empty-key' };
  assert.equal(get(doc, ''), doc);
  assert.equal(get(doc, '/user/name'), 'Ada');
  assert.equal(get(doc, '/user/tags/1'), 'y');
  assert.equal(get(doc, '/'), 'empty-key');
});

test('get returns the fallback for missing paths instead of throwing', () => {
  const doc = { a: { b: 1 }, list: [1] };
  assert.equal(get(doc, '/a/zz', 'fallback'), 'fallback');
  assert.equal(get(doc, '/list/9', 'fallback'), 'fallback');
  assert.equal(get(doc, '/list/-1', 'fallback'), 'fallback');
  assert.equal(get(doc, '/a/b/deeper', 'fallback'), 'fallback');
  assert.equal(get(null, '/a', 'fallback'), 'fallback');
  assert.equal(get({ a: undefined }, '/a', 'fallback'), undefined);
});

test('has reports existence for both objects and arrays', () => {
  const doc = { a: { b: 1 }, list: [10, 20] };
  assert.equal(has(doc, '/a/b'), true);
  assert.equal(has(doc, '/a/b/c'), false);
  assert.equal(has(doc, '/list/1'), true);
  assert.equal(has(doc, '/list/2'), false);
  assert.equal(has(doc, ''), true);
});

test('set writes objects and overwrites existing array slots', () => {
  const doc = { a: { b: 1 }, list: [10, 20] };
  set(doc, '/a/b', 2);
  assert.deepEqual(doc.a, { b: 2 });

  set(doc, '/a/new', { deep: true });
  assert.deepEqual(doc.a.new, { deep: true });
});

test('set overwrites an array element without shifting neighbours', () => {
  const doc = { list: [10, 20] };
  set(doc, '/list/1', 99);
  assert.deepEqual(doc.list, [10, 99], 'replace overwrites in place');

  set(doc, '/list/0', 5);
  assert.deepEqual(doc.list, [5, 99], 'index 0 overwrites the head');
});

test('insert splices at an array index, shifting later items right', () => {
  const doc = { list: [10, 20] };
  insert(doc, '/list/1', 99);
  assert.deepEqual(doc.list, [10, 99, 20], 'RFC 6902 add inserts, it does not overwrite');

  insert(doc, '/list/0', 5);
  assert.deepEqual(doc.list, [5, 10, 99, 20], 'index 0 prepends');

  insert(doc, '/list/-', 7);
  assert.deepEqual(doc.list, [5, 10, 99, 20, 7], '"-" appends');

  insert(doc, '/list/3', 42);
  assert.deepEqual(doc.list, [5, 10, 99, 42, 20, 7], 'an interior index splices');
});

test('insert assigns object keys and rejects out-of-range array indexes', () => {
  const doc = { obj: { a: 1 }, list: [1] };
  insert(doc, '/obj/a', 2);
  assert.deepEqual(doc.obj, { a: 2 }, 'an existing key is overwritten');
  insert(doc, '/obj/b', 3);
  assert.deepEqual(doc.obj, { a: 2, b: 3 }, 'a new key is created');

  assert.throws(() => insert(doc, '/list/5', 0), /out of range/);
  assert.throws(() => insert({ n: 1 }, '/n/child', 0), /not a container/);
});

test('set appends when the index equals the length or the token is -', () => {
  const doc = { list: [10] };
  set(doc, '/list/1', 20);
  assert.deepEqual(doc.list, [10, 20], 'index === length appends');

  set(doc, '/list/-', 30);
  assert.deepEqual(doc.list, [10, 20, 30], '"-" appends');
});

test('set deep-copies the assigned value and returns the root', () => {
  const source = { nested: 1 };
  const doc = {};
  const returned = set(doc, '/slot', source);
  source.nested = 2;
  assert.deepEqual(doc.slot, { nested: 1 });
  assert.equal(returned, doc);
  assert.equal(set(doc, '', 'replaced'), 'replaced', 'empty pointer returns the value');
});

test('set escapes keys containing / and ~', () => {
  const doc = {};
  set(doc, '/a~1b', 1);
  assert.deepEqual(doc, { 'a/b': 1 });
  assert.equal(get(doc, '/a~1b'), 1);
});

test('set rejects out-of-range array indexes and non-container parents', () => {
  const doc = { list: [1], scalar: 3 };
  assert.throws(() => set(doc, '/list/5', 0), /out of range/);
  assert.throws(() => set(doc, '/list/x', 0), /out of range/);
  assert.throws(() => set(doc, '/scalar/child', 0), /not a container/);
  assert.throws(() => set(doc, '/missing/child', 0), /does not exist/);
});

test('remove deletes object keys and splices array items', () => {
  const doc = { a: 1, b: 2, list: [1, 2, 3] };
  remove(doc, '/a');
  assert.deepEqual(doc, { b: 2, list: [1, 2, 3] });

  remove(doc, '/list/1');
  assert.deepEqual(doc.list, [1, 3]);

  assert.throws(() => remove(doc, ''), SyntaxError);
  assert.throws(() => remove(doc, '/nope'), /does not exist/);
  assert.throws(() => remove(doc, '/list/9'), /out of range/);
});

test('set refuses to descend through a null or scalar parent', () => {
  const doc = { tls: null, port: 80 };
  assert.throws(() => set(doc, '/tls/enabled', true), /parent is null, not a container/);
  assert.throws(() => set(doc, '/port/deep', 1), /parent is number, not a container/);
});

test('get/set/remove compose on a realistic document', () => {
  const doc = { service: { name: 'api', ports: [80], tls: { enabled: false } }, version: 1 };
  set(doc, '/service/ports/-', 443);
  set(doc, '/service/tls/enabled', true);
  remove(doc, '/version');

  assert.deepEqual(doc, {
    service: { name: 'api', ports: [80, 443], tls: { enabled: true } },
  });
  assert.equal(get(doc, '/service/tls/enabled'), true);
  assert.equal(has(doc, '/version'), false);
});