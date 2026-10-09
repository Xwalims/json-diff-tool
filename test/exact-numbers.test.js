'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseExact, parseExactPortable, stringifyExact, HAS_SOURCE_CONTEXT } = require('../src/json-number.js');
const { diff, deepEqual } = require('../src/diff.js');
const { applyPatch } = require('../src/apply.js');
const { merge } = require('../src/merge.js');
const { formatOps, formatJson } = require('../src/format.js');
const { loadDocument } = require('../src/cli.js');
const index = require('../src/index.js');

/**
 * The bug this file guards.
 *
 * `JSON.parse` rounds every number onto an IEEE-754 double, so two documents
 * whose only difference is an integer above 2^53-1 became the SAME VALUE.
 * `diff` then returned no operations and the CLI exited 0 -- "the documents
 * are equivalent" -- on documents that differ.
 *
 * Ground truth is Python's json module, which keeps integers exact:
 *
 *     json.loads('{"n":9007199254740993}') != json.loads('{"n":9007199254740992}')
 *     # True
 *
 * `scripts/cross-check-numbers.py` runs that oracle over 313 pairs. These
 * tests pin the specific behaviours that oracle depends on, so a future
 * refactor that breaks the property fails here first and in milliseconds.
 */

test('a big integer survives parsing exactly', () => {
  const doc = parseExact('{"n":9007199254740993}');
  assert.equal(typeof doc.n, 'bigint');
  assert.equal(doc.n, 9007199254740993n);
  assert.equal(doc.n.toString(), '9007199254740993');
});

test('documents differing only above 2^53 are NOT reported as identical', () => {
  const a = parseExact('{"id":123456789012345678}');
  const b = parseExact('{"id":123456789012345679}');
  assert.deepEqual(diff(a, b), [
    { op: 'replace', path: '/id', oldValue: 123456789012345678n, value: 123456789012345679n },
  ]);
});

test('the exact 2^53 boundary is handled on both sides', () => {
  // 2^53 - 1 is the largest exactly-representable integer: still a double.
  assert.equal(typeof parseExact('{"n":9007199254740991}').n, 'number');
  // 2^53 is not representable as a distinct value, so it must be exact.
  assert.equal(parseExact('{"n":9007199254740992}').n, 9007199254740992n);
  assert.equal(deepEqual(parseExact('{"n":9007199254740992}'), parseExact('{"n":9007199254740993}')), false);
});

test('an integer and a float that spell the same value are still equal', () => {
  // 1 and 1.0 are both exactly the value 1. They must not become a diff just
  // because one of them is now a BigInt-shaped integer literal.
  assert.equal(deepEqual(parseExact('{"n":1}'), parseExact('{"n":1.0}')), true);
  assert.equal(deepEqual(parseExact('{"n":0}'), parseExact('{"n":0.0}')), true);
});

test('a fractional value is NOT turned into an exact integer', () => {
  const doc = parseExact('{"n":1.5,"e":1e3,"z":0}');
  assert.equal(typeof doc.n, 'number');
  assert.equal(typeof doc.e, 'number');
  assert.equal(typeof doc.z, 'number');
  assert.equal(doc.n, 1.5);
});

test('numbers inside the safe range are untouched by the parser', () => {
  const doc = parseExact('{"a":1,"b":-2,"c":3.5,"d":1e-7,"e":9007199254740991}');
  for (const key of ['a', 'b', 'c', 'd', 'e']) {
    assert.equal(typeof doc[key], 'number', `${key} should stay a number`);
  }
});

test('deepEqual keeps a BigInt distinct from the number it equals loosely', () => {
  // `0 == 0n` is true in JS. A diff tool that used a loose comparison would
  // call these documents identical, which is wrong: 0 and 9007199254740992
  // are different values in the file.
  assert.equal(deepEqual(0n, 0), false);
  assert.equal(deepEqual(9007199254740992n, 9007199254740992), false);
});

test('stringifyExact writes a BigInt as a bare number, not a quoted string', () => {
  // The trap: a replacer returning String(bigint) yields '{"n":"10"}'.
  const text = stringifyExact({ n: 9007199254740993n });
  assert.equal(text, '{"n":9007199254740993}');
  assert.equal(text.includes('"9007'), false);
  // And it is still parseable as a number by an exact reader.
  assert.equal(parseExact(text).n, 9007199254740993n);
});

test('stringifyExact is byte-identical to JSON.stringify without a BigInt', () => {
  const samples = [
    { a: 1, b: 'x', c: [1, 2, { d: null }] },
    { 'quo"te': 'back\\slash', 'uni😀': 'tab\there', empty: {}, none: [] },
    [1, 'two', false, null, { nested: 1.5 }],
    'a bare string',
    42,
    null,
    true,
    [],
    {},
    { negative: -0.5, exp: 1e-7, big: 1e21 },
  ];
  for (const sample of samples) {
    for (const indent of [undefined, 0, 2, 4]) {
      assert.equal(
        stringifyExact(sample, indent),
        JSON.stringify(sample, null, indent),
        `mismatch for ${JSON.stringify(sample)} at indent ${indent}`
      );
    }
  }
});

test('stringifyExact round-trips a document containing an exact integer', () => {
  const source = '{"n":9007199254740993,"s":"x","a":[1,2]}';
  const doc = parseExact(source);
  assert.deepEqual(parseExact(stringifyExact(doc)), doc);
  // Pretty-printed output must re-parse to the same document as well.
  assert.deepEqual(parseExact(stringifyExact(doc, 2)), doc);
});

test('formatOps prints the exact integer, not the rounded one', () => {
  const ops = diff(
    parseExact('{"id":9007199254740992}'),
    parseExact('{"id":9007199254740993}')
  );
  const text = formatOps(ops);
  assert.match(text, /9007199254740993/);
  assert.match(text, /9007199254740992/);
});

test('formatJson output re-parses as the operation list applyPatch expects', () => {
  const ops = diff(
    parseExact('{"id":9007199254740992}'),
    parseExact('{"id":9007199254740993}')
  );
  const text = formatJson(ops);
  assert.match(text, /9007199254740993/);
  // The whole point of --json: feed it back in and the patch applies.
  const patched = applyPatch(parseExact('{"id":9007199254740992}'), parseExact(text));
  assert.equal(patched.id, 9007199254740993n);
});

test('diff then applyPatch reproduces the target document exactly', () => {
  const a = parseExact('{"id":9007199254740993,"n":1}');
  const b = parseExact('{"id":9007199254740999,"n":1}');
  const patched = applyPatch(a, diff(a, b));
  assert.equal(patched.id, 9007199254740999n);
  assert.equal(stringifyExact(patched), stringifyExact(b));
});

test('an exact integer survives merge', () => {
  const merged = merge({ id: 9007199254740992n }, { other: 1 });
  assert.equal(merged.id, 9007199254740992n);
  assert.match(stringifyExact(merged), /9007199254740992/);
});

test('cloneValues deep-copy does not flatten an exact integer', () => {
  // diff/merge/apply all structuredClone their values. A wrapper class would
  // have lost its prototype here, which is why the fix uses BigInt.
  const ops = diff(
    parseExact('{"id":9007199254740992}'),
    parseExact('{"id":9007199254740993}')
  );
  assert.equal(typeof ops[0].value, 'bigint');
  assert.equal(typeof ops[0].oldValue, 'bigint');
});

test('loadDocument keeps an exact integer', async () => {
  const path = require('node:path').join(require('node:os').tmpdir(), `json-diff-exact-${process.pid}.json`);
  require('node:fs').writeFileSync(path, '{"id":9007199254740993}');
  try {
    const doc = await loadDocument(path, 'document A');
    assert.equal(doc.id, 9007199254740993n);
  } finally {
    require('node:fs').unlinkSync(path);
  }
});

test('the exact-number pair is exported from the package entry point', () => {
  assert.equal(typeof index.parseExact, 'function');
  assert.equal(typeof index.stringifyExact, 'function');
  // And the package entry point agrees with the module it re-exports.
  assert.equal(index.parseExact('{"n":9007199254740993}').n, 9007199254740993n);
});

test('malformed JSON still throws a SyntaxError', () => {
  assert.throws(() => parseExact('{'), SyntaxError);
  assert.throws(() => parseExact('{"a":}'), SyntaxError);
  assert.throws(() => parseExact(''), SyntaxError);
});

test('a negative big integer round-trips with its sign', () => {
  const doc = parseExact('{"n":-9007199254740993}');
  assert.equal(doc.n, -9007199254740993n);
  assert.equal(stringifyExact(doc), '{"n":-9007199254740993}');
});

/*
 * The portable parser exists because the fast path depends on the reviver's
 * raw-source context, which is not available on every Node this package
 * supports. These tests pin the two bugs it had when first written, because
 * both were found by a collision probe rather than by reasoning:
 *
 *   - a bare root literal (`9007199254740993` as the whole document) came back
 *     as the internal sentinel STRING, turning a number into a string;
 *   - the sentinel prefix was guessable, so a document whose own string value
 *     equalled a sentinel had that string replaced by a BigInt.
 *
 * Both corrupt data silently, which is worse than the rounding bug that
 * started this file.
 */

test('the portable parser and the fast parser agree', () => {
  // Whichever path this runtime takes, the public entry point must match the
  // portable one exactly, or the Node 20 build would behave differently.
  assert.equal(typeof HAS_SOURCE_CONTEXT, 'boolean');
  const cases = [
    '{"n":9007199254740993}',
    '{"n":9007199254740993,"s":"x"}',
    '{"b":1,"2":9007199254740993,"a":2}',
    '[9007199254740993,1,9007199254740995]',
    '{"n":1.5,"e":1e3}',
    '{"a":42}',
    '{"n":-9007199254740993}',
    '9007199254740993',
    '{"deep":{"x":[{"y":9007199254740997}]}}',
    // A number that merely LOOKS like an integer inside a string is data.
    '{"n":"9007199254740993"}',
  ];
  for (const source of cases) {
    const fast = stringifyExact(parseExact(source));
    const portable = stringifyExact(parseExactPortable(source));
    assert.equal(portable, fast, `paths disagree on ${source}`);
  }
});

test('the portable parser keeps a bare root integer a number', () => {
  // Regression: this returned the internal sentinel STRING.
  const value = parseExactPortable('9007199254740993');
  assert.equal(typeof value, 'bigint');
  assert.equal(value, 9007199254740993n);
});

test('the portable parser cannot be fooled by a forged sentinel', () => {
  // Regression: a document whose string value equals a sentinel had that
  // string replaced by a BigInt. Each of these is a string the document
  // really contains, and every one must survive as a string.
  const hostile = [
    '{"s":"\\u00000","real":9007199254740993}',
    '{"s":"\\u0000","real":9007199254740993}',
    '{"a":["\\u00000","\\u00001"],"real":9007199254740993}',
    '{"s":{"nested":"\\u00000"},"real":9007199254740995}',
    '{"s":"\\ue000json-exact-number\\ue000:0","real":9007199254740995}',
    '{"s":"json-exact-number:7","real":9007199254740997}',
  ];
  for (const source of hostile) {
    const doc = parseExactPortable(source);
    // Every non-numeric value in the original must still be a string, and the
    // one integer must still be an exact BigInt.
    const strings = [];
    (function walk(node) {
      if (typeof node === 'string') { strings.push(node); return; }
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      for (const key of Object.keys(node)) walk(node[key]);
    })(doc);
    const original = parseExact(JSON.stringify(JSON.parse(source)));
    const originalStrings = [];
    (function walkOriginal(node) {
      if (typeof node === 'string') { originalStrings.push(node); return; }
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walkOriginal); return; }
      for (const key of Object.keys(node)) walkOriginal(node[key]);
    })(original);
    assert.deepEqual(strings, originalStrings, `string data was eaten in ${source}`);
    assert.equal(typeof doc.real, 'bigint', `integer was lost in ${source}`);
  }
});

test('the portable parser round-trips through serialisation', () => {
  const source = '{"n":9007199254740993,"s":"\\u0000tail","a":[1,9007199254740995]}';
  const doc = parseExactPortable(source);
  assert.deepEqual(parseExact(stringifyExact(doc)), doc);
});