'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatOps, formatJson, format, formatSummary } = require('../src/format.js');
const { diff } = require('../src/diff.js');

test('formatOps renders an empty operation list as an empty string', () => {
  assert.equal(formatOps([]), '');
});

test('formatOps rejects a non-array input', () => {
  assert.throws(() => formatOps('nope'), TypeError);
  assert.throws(() => formatOps(null), TypeError);
  assert.throws(() => formatJson('nope'), TypeError);
});

test('formatOps groups by kind in add, replace, remove order', () => {
  const text = formatOps([
    { op: 'remove', path: '/gone', oldValue: 1 },
    { op: 'replace', path: '/chg', value: 2, oldValue: 1 },
    { op: 'add', path: '/new', value: 3 },
  ]);
  assert.deepEqual(text.split('\n').filter(Boolean), [
    'added (1):',
    '  + /new   = 3',
    'changed (1):',
    '  ~ /chg   1 -> 2',
    'removed (1):',
    '  - /gone  1',
  ]);
});

test('formatOps aligns the value column across differing path lengths', () => {
  const text = formatOps([
    { op: 'replace', path: '/a', value: 2, oldValue: 1 },
    { op: 'replace', path: '/long/nested/path', value: 3, oldValue: 2 },
  ]);
  const lines = text.split('\n').filter((line) => line.startsWith('  ~'));
  assert.equal(lines.length, 2);
  // Both value columns start at the same offset, determined by the widest path.
  const valueColumn = lines[0].indexOf('1 ->');
  assert.equal(lines[1].indexOf('2 ->'), valueColumn);
});

test('formatOps quotes strings so empty values stay visible', () => {
  const text = formatOps([
    { op: 'add', path: '/s', value: '' },
    { op: 'remove', path: '/t', oldValue: '  ' },
  ]);
  assert.match(text, /""/);
  assert.match(text, /"  "/);
});

test('formatOps renders non-string values as JSON', () => {
  const text = formatOps([
    { op: 'add', path: '/obj', value: { a: 1 } },
    { op: 'add', path: '/bool', value: true },
    { op: 'add', path: '/null', value: null },
    { op: 'add', path: '/num', value: 1.5 },
  ]);
  assert.match(text, /\{"a":1\}/);
  assert.match(text, /true/);
  assert.match(text, /null/);
  assert.match(text, /1\.5/);
});

test('formatOps truncates long values by default', () => {
  const text = formatOps([{ op: 'add', path: '/long', value: 'x'.repeat(200) }]);
  assert.match(text, /\.\.\./);
  assert.ok(text.length < 200, 'the rendered line stays readable');
});

test('maxValueLength 0 disables truncation', () => {
  const text = formatOps([{ op: 'add', path: '/long', value: 'x'.repeat(200) }], {
    maxValueLength: 0,
  });
  assert.doesNotMatch(text, /\.\.\./);
  assert.match(text, new RegExp(`x{200}`));
});

test('showValues false prints paths only', () => {
  const text = formatOps([
    { op: 'replace', path: '/a', value: 2, oldValue: 1 },
    { op: 'add', path: '/b', value: 3 },
  ], { showValues: false });
  assert.match(text, /~ \/a$/m);
  assert.match(text, /\+ \/b$/m);
  assert.doesNotMatch(text, /->/);
});

test('formatOps omits value columns that were suppressed during the diff', () => {
  const ops = diff({ a: 1 }, { a: 2 }, { includeValue: false, includeOldValue: false });
  const text = formatOps(ops);
  assert.match(text, /~ \/a$/m, 'no dangling arrow when both values are absent');
  assert.doesNotMatch(text, /->/);
});

test('formatOps output is deterministic for the same input', () => {
  const ops = diff(
    { a: 1, list: [1, 2], obj: { x: 1 } },
    { a: 2, list: [1, 3], obj: { y: 1 } }
  );
  assert.equal(formatOps(ops), formatOps(ops));
});

test('formatOps output does not depend on input key order', () => {
  const forward = formatOps(diff({ z: 1, a: 1 }, { z: 2, a: 2 }));
  const reversed = formatOps(diff({ a: 1, z: 1 }, { a: 2, z: 2 }));
  assert.equal(forward, reversed);
});

test('formatOps handles an escaped pointer path', () => {
  const text = formatOps([{ op: 'replace', path: '/a~1b', value: 2, oldValue: 1 }]);
  assert.match(text, /~ \/a~1b\s+1 -> 2/);
});

test('formatOps ends with exactly one trailing newline', () => {
  const text = formatOps([{ op: 'add', path: '/a', value: 1 }]);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
});

test('formatOps counts each group in its header', () => {
  const text = formatOps([
    { op: 'add', path: '/a', value: 1 },
    { op: 'add', path: '/b', value: 2 },
    { op: 'add', path: '/c', value: 3 },
  ]);
  assert.match(text, /added \(3\):/);
});

test('formatOps pads multi-byte paths by display width', () => {
  const text = formatOps([
    { op: 'add', path: '/ünïcødé', value: 1 },
    { op: 'add', path: '/b', value: 2 },
  ]);
  const lines = text.split('\n').filter((line) => line.startsWith('  +'));
  assert.equal(lines[0].indexOf('1'), lines[1].indexOf('2'));
});

test('formatJson emits a parseable array ending in a newline', () => {
  const ops = [{ op: 'replace', path: '/a', value: 2, oldValue: 1 }];
  const text = formatJson(ops);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), ops);
});

test('formatJson honours the indent option', () => {
  const ops = [{ op: 'add', path: '/a', value: { nested: 1 } }];
  assert.match(formatJson(ops, { indent: 0 }), /\{"op":"add"/);
  assert.match(formatJson(ops, { indent: 4 }), /\n {4}\{/);
});

test('formatJson of an empty list is an empty array', () => {
  assert.equal(formatJson([]).trim(), '[]');
});

test('format selects the machine or text format', () => {
  const ops = [{ op: 'add', path: '/a', value: 1 }];
  assert.equal(format(ops, { asJson: true }), formatJson(ops));
  assert.equal(format(ops), formatOps(ops));
});

test('formatJson round-trips back into applyPatch', () => {
  const { applyPatch } = require('../src/apply.js');
  const before = { a: 1, list: [1, 2] };
  const after = { a: 2, list: [1, 2, 3] };
  const ops = diff(before, after, { arrayMode: 'lcs' });
  assert.deepEqual(applyPatch(before, JSON.parse(formatJson(ops))), after);
});

test('formatSummary describes the counts in a stable order', () => {
  assert.equal(
    formatSummary([{ op: 'add', path: '/a', value: 1 }]),
    '1 operation: 1 added, 0 changed, 0 removed'
  );
  assert.equal(
    formatSummary([
      { op: 'add', path: '/a', value: 1 },
      { op: 'remove', path: '/b' },
      { op: 'replace', path: '/c', value: 1, oldValue: 0 },
    ]),
    '3 operations: 1 added, 1 changed, 1 removed'
  );
  assert.equal(formatSummary([]), '0 operations: 0 added, 0 changed, 0 removed');
});

test('a realistic diff renders into a stable, readable report', () => {
  const before = {
    service: 'api',
    replicas: 2,
    env: { LOG_LEVEL: 'info', REGION: 'eu' },
    hosts: ['a.example.com', 'b.example.com'],
  };
  const after = {
    service: 'api',
    replicas: 4,
    env: { LOG_LEVEL: 'debug' },
    hosts: ['a.example.com', 'b.example.com', 'c.example.com'],
  };
  const ops = diff(before, after, { arrayMode: 'lcs' });

  assert.equal(
    formatOps(ops),
    [
      'added (1):',
      '  + /hosts/2        = "c.example.com"',
      '',
      'changed (2):',
      '  ~ /env/LOG_LEVEL  "info" -> "debug"',
      '  ~ /replicas       2 -> 4',
      '',
      'removed (1):',
      '  - /env/REGION     "eu"',
      '',
    ].join('\n')
  );
});