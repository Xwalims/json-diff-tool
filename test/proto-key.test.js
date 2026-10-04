'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { set, insert, remove, get, has } = require('../src/pointer.js');
const { merge } = require('../src/merge.js');
const { diff } = require('../src/diff.js');
const { applyPatch } = require('../src/apply.js');

/**
 * A JSON document can legitimately contain a key literally named
 * "__proto__" — JSON.parse stores it as an own data property. Plain
 * assignment `obj[key] = value` does *not* create that property: it hits the
 * `Object.prototype.__proto__` accessor and retargets the prototype instead.
 * Every write path that goes through `parent[token] = ...` therefore drops
 * the key from the document and moves its contents out of sight.
 *
 * These tests pin that writes create an own data property, never a
 * prototype mutation, and that a diff/apply round-trip stays faithful.
 */

/**
 * Read the value of an OWN `__proto__` data property.
 *
 * `object.__proto__` would work here, because an own property shadows the
 * inherited accessor, but going through the descriptor states the intent and
 * cannot silently change meaning if the shadowing ever stops holding.
 */
function ownProtoValue(object) {
  return Object.getOwnPropertyDescriptor(object, '__proto__').value;
}

/** Assert that `object` carries an own `__proto__` data property. */
function assertOwnProtoKey(object, expected) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(object, '__proto__'),
    true,
    'the literal "__proto__" key must survive as an own property'
  );
  // Compare the two values directly. Wrapping them in `{ __proto__: v }` would
  // NOT work: in an object literal `__proto__` is a prototype setter, never an
  // own-property definition, so that expression builds an object with zero own
  // keys whose prototype is `v`. Comparing those compares two empty objects
  // and passes whatever the values were — the assertion checked nothing.
  assert.deepEqual(ownProtoValue(object), expected, 'the own "__proto__" property must hold the written value');
}

test('set stores a literal __proto__ key as an own property', () => {
  const doc = {};
  set(doc, '/__proto__', { role: 'admin' });
  assertOwnProtoKey(doc, { role: 'admin' });
  assert.equal(get(doc, '/__proto__/role'), 'admin');
});

test('set does not retarget the prototype of the document it writes to', () => {
  const doc = { a: 1 };
  set(doc, '/__proto__', { role: 'admin' });
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
});

test('set does not leak the written value onto unrelated objects', () => {
  const doc = {};
  set(doc, '/__proto__', { role: 'admin' });
  assert.equal({}.role, undefined, 'no property may appear on a fresh object');
});

test('set writes __proto__ under a nested parent too', () => {
  const doc = { cfg: {} };
  set(doc, '/cfg/__proto__', { role: 'admin' });
  assertOwnProtoKey(doc.cfg, { role: 'admin' });
  assert.equal(Object.getPrototypeOf(doc.cfg), Object.prototype);
});

test('set overwrites an existing __proto__ key parsed from JSON', () => {
  const doc = JSON.parse('{"__proto__":{"role":"user"}}');
  set(doc, '/__proto__', { role: 'admin' });
  assertOwnProtoKey(doc, { role: 'admin' });
});

test('insert stores a literal __proto__ key as an own property', () => {
  const doc = {};
  insert(doc, '/__proto__', { role: 'admin' });
  assertOwnProtoKey(doc, { role: 'admin' });
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
});

test('remove deletes an own __proto__ key without touching the prototype', () => {
  const doc = JSON.parse('{"a":1,"__proto__":{"role":"admin"}}');
  remove(doc, '/__proto__');
  assert.deepEqual(Object.keys(doc), ['a']);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.equal({}.role, undefined);
});

test('has and get address an own __proto__ key', () => {
  const doc = JSON.parse('{"__proto__":{"role":"admin"}}');
  assert.equal(has(doc, '/__proto__'), true);
  assert.equal(get(doc, '/__proto__/role'), 'admin');
});

test('a written __proto__ key is an ordinary data property', () => {
  // A key stored by set()/insert() must be indistinguishable from the same
  // key as it arrives from JSON.parse: writable, enumerable, configurable.
  const written = {};
  set(written, '/__proto__', { role: 'admin' });
  const parsed = JSON.parse('{"__proto__":{"role":"admin"}}');

  for (const label of ['writable', 'enumerable', 'configurable']) {
    assert.equal(
      Object.getOwnPropertyDescriptor(written, '__proto__')[label],
      Object.getOwnPropertyDescriptor(parsed, '__proto__')[label],
      `the "__proto__" property must be ${label}, exactly as after JSON.parse`
    );
  }
  // And a second write through the pointer must replace the value, which only
  // holds for a writable property.
  set(written, '/__proto__', { role: 'user' });
  // Direct value comparison — see assertOwnProtoKey for why `{ __proto__: v }`
  // would be a prototype mutation that passes unconditionally.
  assert.deepEqual(ownProtoValue(written), { role: 'user' });
});

test('merge carries a __proto__ key through instead of dropping it', () => {
  const result = merge({}, JSON.parse('{"__proto__":{"role":"admin"}}'));
  assertOwnProtoKey(result, { role: 'admin' });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('merge keeps __proto__ when the key exists on both sides', () => {
  const result = merge(
    JSON.parse('{"__proto__":{"a":1}}'),
    JSON.parse('{"__proto__":{"b":2}}')
  );
  assertOwnProtoKey(result, { a: 1, b: 2 });
});

test('merge keeps __proto__ on a nested parent', () => {
  const result = merge({ cfg: {} }, JSON.parse('{"cfg":{"__proto__":{"role":"admin"}}}'));
  assertOwnProtoKey(result.cfg, { role: 'admin' });
});

test('diff and applyPatch round-trip a document that gains a __proto__ key', () => {
  const before = JSON.parse('{"a":1}');
  const after = JSON.parse('{"a":1,"__proto__":{"role":"admin"}}');
  const out = applyPatch(before, diff(before, after, { includeOldValue: false }));
  assertOwnProtoKey(out, { role: 'admin' });
  assert.equal(JSON.stringify(out), JSON.stringify(after));
  assert.deepEqual(pointerKeys(out), ['__proto__', 'a']);
});

test('diff and applyPatch round-trip a document that loses a __proto__ key', () => {
  const before = JSON.parse('{"a":1,"__proto__":{"role":"admin"}}');
  const after = JSON.parse('{"a":1}');
  const out = applyPatch(before, diff(before, after, { includeOldValue: false }));
  assert.deepEqual(Object.keys(out), ['a']);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal({}.role, undefined);
});

/** Own enumerable keys, sorted, so key order cannot mask a difference. */
function pointerKeys(object) {
  return Object.keys(object).sort();
}