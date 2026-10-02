'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'json-diff.js');

/**
 * Create an isolated temp directory for a test case.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @returns {string} Absolute path to the temp directory.
 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-diff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write a JSON document to a temp file.
 *
 * @param {string} dir Directory to write into.
 * @param {string} name File name.
 * @param {*} data Value to serialise.
 * @returns {string} Absolute path to the file.
 */
function writeJson(dir, name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return file;
}

/**
 * Run the CLI in a child process and capture its output.
 *
 * @param {string[]} args CLI arguments.
 * @param {object} [options] Spawn options.
 * @param {string} [options.input] Data to feed to stdin.
 * @param {string} [options.cwd] Working directory.
 * @returns {{status: number, stdout: string, stderr: string}} The result.
 */
function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: options.input ?? '',
    cwd: options.cwd ?? path.join(__dirname, '..'),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('exit code is 0 and output says no differences for equal documents', (t) => {
  const dir = tempDir(t);
  const file = writeJson(dir, 'a.json', { a: 1, b: [1, 2] });
  const other = writeJson(dir, 'b.json', { a: 1, b: [1, 2] });

  const { status, stdout } = runCli([file, other]);
  assert.equal(status, 0);
  assert.equal(stdout, 'no differences\n');
});

test('exit code is 1 and the diff is printed when documents differ', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', { a: 2 });

  const { status, stdout } = runCli([a, b]);
  assert.equal(status, 1);
  assert.equal(
    stdout,
    ['changed (1):', '  ~ /a  1 -> 2', '', '1 operation: 0 added, 1 changed, 0 removed', ''].join('\n')
  );
});

test('the grouped text output matches the documented layout', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', {
    service: 'api',
    replicas: 2,
    image: { repo: 'acme/api', tag: '1.0.0' },
    env: { LOG_LEVEL: 'info', REGION: 'eu-west-1' },
    hosts: ['a.example.com', 'b.example.com'],
  });
  const b = writeJson(dir, 'b.json', {
    service: 'api',
    replicas: 4,
    image: { repo: 'acme/api', tag: '1.1.0' },
    env: { LOG_LEVEL: 'debug' },
    hosts: ['a.example.com', 'b.example.com', 'c.example.com'],
  });

  const { status, stdout } = runCli([a, b, '--array-mode', 'lcs']);
  assert.equal(status, 1);
  assert.equal(
    stdout,
    [
      'added (1):',
      '  + /hosts/2        = "c.example.com"',
      '',
      'changed (3):',
      '  ~ /env/LOG_LEVEL  "info" -> "debug"',
      '  ~ /image/tag      "1.0.0" -> "1.1.0"',
      '  ~ /replicas       2 -> 4',
      '',
      'removed (1):',
      '  - /env/REGION     "eu-west-1"',
      '',
      '5 operations: 1 added, 3 changed, 1 removed',
      '',
    ].join('\n')
  );
});

test('--json emits a parseable operation array on stdout', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1, b: 'x' });
  const b = writeJson(dir, 'b.json', { a: 2 });

  const { status, stdout } = runCli([a, b, '--json']);
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, [
    { op: 'replace', path: '/a', value: 2, oldValue: 1 },
    { op: 'remove', path: '/b', oldValue: 'x' },
  ]);
});

test('--json emits an empty array for identical documents', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', { a: 1 });

  const { status, stdout } = runCli([a, b, '--json']);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), []);
});

test('--array-mode lcs turns a prepend into one operation instead of six', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', [1, 2, 3, 4, 5, 6]);
  const b = writeJson(dir, 'b.json', [0, 1, 2, 3, 4, 5, 6]);

  const index = runCli([a, b, '--json']);
  const lcs = runCli([a, b, '--json', '--array-mode', 'lcs']);

  const indexOps = JSON.parse(index.stdout);
  const lcsOps = JSON.parse(lcs.stdout);
  assert.equal(indexOps.length, 7);
  assert.equal(lcsOps.length, 1);
  assert.deepEqual(lcsOps, [{ op: 'add', path: '/0', value: 0 }]);
});

test('--no-values prints paths only', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', { a: 2 });

  const { status, stdout } = runCli([a, b, '--no-values']);
  assert.equal(status, 1);
  assert.match(stdout, /~ \/a$/m);
  assert.doesNotMatch(stdout, /->/);
});

test('--quiet prints nothing and signals through the exit code', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', { a: 2 });

  const different = runCli([a, b, '--quiet']);
  assert.equal(different.status, 1);
  assert.equal(different.stdout, '');

  const same = runCli([a, a, '--quiet']);
  assert.equal(same.status, 0);
  assert.equal(same.stdout, '');
});

test('--out writes the operation array to a file', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1, gone: 2 });
  const b = writeJson(dir, 'b.json', { a: 5, added: 3 });
  const out = path.join(dir, 'nested', 'patch.json');

  const { status } = runCli([a, b, '--out', out]);
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [
    { op: 'replace', path: '/a', value: 5, oldValue: 1 },
    { op: 'add', path: '/added', value: 3 },
    { op: 'remove', path: '/gone', oldValue: 2 },
  ]);
});

test('a document can be read from stdin with -', (t) => {
  const dir = tempDir(t);
  const a = { a: 1, b: 2 };
  const file = writeJson(dir, 'b.json', { a: 9 });

  const { status, stdout } = runCli(['-', file, '--json'], { input: JSON.stringify(a) });
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(stdout), [
    { op: 'replace', path: '/a', value: 9, oldValue: 1 },
    { op: 'remove', path: '/b', oldValue: 2 },
  ]);
});

test('--merge deep-merges B onto A', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { keep: 1, list: [1], nested: { x: 1 } });
  const b = writeJson(dir, 'b.json', { list: [2], nested: { y: 2 } });

  const { status, stdout } = runCli([a, b, '--merge']);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), { keep: 1, list: [2], nested: { x: 1, y: 2 } });
});

test('--merge-array concat and union change the result', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { list: [1, 2] });
  const b = writeJson(dir, 'b.json', { list: [2, 3] });

  const concat = runCli([a, b, '--merge', '--merge-array', 'concat']);
  assert.deepEqual(JSON.parse(concat.stdout), { list: [1, 2, 2, 3] });

  const union = runCli([a, b, '--merge', '--merge-array', 'union']);
  assert.deepEqual(JSON.parse(union.stdout), { list: [1, 2, 3] });

  const replace = runCli([a, b, '--merge']);
  assert.deepEqual(JSON.parse(replace.stdout), { list: [2, 3] });
});

test('--merge-null ignore keeps the base value', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', { a: null });

  assert.deepEqual(JSON.parse(runCli([a, b, '--merge']).stdout), { a: null });
  assert.deepEqual(JSON.parse(runCli([a, b, '--merge', '--merge-null', 'ignore']).stdout), { a: 1 });
});

test('exit code is 2 when a file does not exist', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });

  const { status, stderr } = runCli([a, path.join(dir, 'missing.json')]);
  assert.equal(status, 2);
  assert.match(stderr, /cannot read document B/);
});

test('exit code is 2 on invalid JSON', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', '{ not json ');

  const { status, stderr } = runCli([a, b]);
  assert.equal(status, 2);
  assert.match(stderr, /is not valid JSON/);
});

test('exit code is 2 on an empty file', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', '   ');

  const { status, stderr } = runCli([a, b]);
  assert.equal(status, 2);
  assert.match(stderr, /is empty/);
});

test('exit code is 2 when the document count is wrong', () => {
  const missing = runCli([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /expected exactly 2 documents, received 0/);

  const one = runCli(['only-one.json']);
  assert.equal(one.status, 2);
  assert.match(one.stderr, /received 1/);

  const three = runCli(['a.json', 'b.json', 'c.json']);
  assert.equal(three.status, 2);
  assert.match(three.stderr, /received 3/);
});

test('exit code is 2 on an unknown option', () => {
  const { status, stderr } = runCli(['a.json', 'b.json', '--nope']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown option "--nope"/);
  assert.match(stderr, /Usage: json-diff/);
});

test('exit code is 2 on an invalid array mode', () => {
  const { status, stderr } = runCli(['a.json', 'b.json', '--array-mode', 'greedy']);
  assert.equal(status, 2);
  assert.match(stderr, /--array-mode must be "index" or "lcs"/);
});

test('exit code is 2 when a flag is missing its value', () => {
  const arrayMode = runCli(['a.json', 'b.json', '--array-mode']);
  assert.equal(arrayMode.status, 2);
  assert.match(arrayMode.stderr, /--array-mode requires a value/);

  const out = runCli(['a.json', 'b.json', '--out']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--out requires a value/);
});

test('--help prints usage and exits 0', () => {
  const { status, stdout } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /Usage: json-diff <A\.json> <B\.json> \[options\]/);
  assert.match(stdout, /--array-mode <index\|lcs>/);
  assert.match(stdout, /Exit codes:/);
});

test('--version prints the package name and version', () => {
  const { status, stdout } = runCli(['--version']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), 'json-diff-tool 0.1.0');
});

test('the CLI works from any working directory', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { a: 1 });
  const b = writeJson(dir, 'b.json', { a: 2 });

  const { status, stdout } = runCli([a, b], { cwd: os.tmpdir() });
  assert.equal(status, 1);
  assert.match(stdout, /~ \/a\s+1 -> 2/);
});

test('the emitted patch applies back to the original document', (t) => {
  const dir = tempDir(t);
  const before = {
    name: 'api',
    count: 1,
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    tags: ['x'],
  };
  const after = {
    name: 'api',
    count: 2,
    items: [{ id: 'a' }, { id: 'B' }],
    tags: ['x', 'y'],
  };
  const a = writeJson(dir, 'a.json', before);
  const b = writeJson(dir, 'b.json', after);
  const out = path.join(dir, 'patch.json');

  runCli([a, b, '--array-mode', 'lcs', '--out', out]);

  const { applyPatch } = require('../src/apply.js');
  assert.deepEqual(applyPatch(before, JSON.parse(fs.readFileSync(out, 'utf8'))), after);
});

test('output is stable across runs and independent of key order', (t) => {
  const dir = tempDir(t);
  const a = writeJson(dir, 'a.json', { z: 1, a: 1, m: 1 });
  const b = writeJson(dir, 'b.json', { z: 2, a: 2, m: 2 });
  const bReordered = writeJson(dir, 'b2.json', { m: 2, z: 2, a: 2 });

  const first = runCli([a, b]);
  const second = runCli([a, b]);
  const reordered = runCli([a, bReordered]);

  assert.equal(first.stdout, second.stdout, 'repeated runs are byte-identical');
  assert.equal(first.stdout, reordered.stdout, 'key order does not affect output');
});
