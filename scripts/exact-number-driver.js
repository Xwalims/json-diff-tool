#!/usr/bin/env node
'use strict';

/**
 * json-diff-tool / scripts/exact-number-driver.js
 *
 * Test harness for scripts/cross-check-numbers.py, which checks this tool
 * against Python's json module as an external oracle.
 *
 * Usage:
 *   node scripts/exact-number-driver.js <a.json> <b.json> [auto|fast|portable]
 *
 * THE MODE ARGUMENT IS NOT OPTIONAL PLUMBING
 * ------------------------------------------
 * There are two parse paths (see src/json-number.js): `fast`, which reads the
 * raw literal out of JSON.parse's reviver context, and `portable`, which does
 * not and is what runs on the Node 20 this package declares as its floor.
 *
 * `auto` is `parseExact`, which on any modern runtime takes `fast` and never
 * calls `portable` at all. So a run that only ever exercises `auto` has
 * checked nothing about the Node-20 path -- while looking like a full pass.
 * That is not hypothetical: the first version of this driver accepted a mode
 * argument and ignored it, so `--fast` and `--portable` both silently ran
 * `auto`, and the portable path was never compared to the oracle once.
 *
 * So the mode is enforced here, not trusted: `parseFor` throws when the
 * requested path is not available on this runtime, and the caller sees a
 * non-zero exit rather than a green line.
 *
 * Output is JSON: the op count, the operations, and document A re-emitted.
 * The echo is what makes the oracle a round-trip check -- a tool that notices
 * the difference and then prints the rounded number has not fixed anything.
 */

const dt = require('../src/index.js');
const jn = require('../src/json-number.js');
const fs = require('fs');

const MODE = process.argv[4] || 'auto';

/**
 * Parse text with exactly the requested path, or fail loudly.
 *
 * @param {string} text JSON source text.
 * @returns {*} The parsed value.
 * @throws {Error} If the requested path does not exist on this runtime.
 */
function parseFor(text) {
  switch (MODE) {
    case 'portable':
      return jn.parseExactPortable(text);
    case 'fast':
      if (!jn.HAS_SOURCE_CONTEXT) {
        throw new Error(
          'this runtime has no JSON.parse reviver context, so the fast path '
          + 'cannot run here; run with mode=portable or auto',
        );
      }
      // parseExact is the fast path whenever context is available, and this
      // branch is only reachable when it is.
      return jn.parseExact(text);
    case 'auto':
      return jn.parseExact(text);
    default:
      throw new Error('unknown mode ' + JSON.stringify(MODE));
  }
}

let a;
let b;
try {
  a = parseFor(fs.readFileSync(process.argv[2], 'utf8'));
  b = parseFor(fs.readFileSync(process.argv[3], 'utf8'));
} catch (err) {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
}

const ops = dt.diff(a, b);
process.stdout.write(dt.stringifyExact({
  n: ops.length,
  ops: ops.map((o) => ({
    op: o.op,
    path: o.path,
    value: o.value === undefined ? undefined : dt.stringifyExact(o.value),
    oldValue: o.oldValue === undefined ? undefined : dt.stringifyExact(o.oldValue),
  })),
  echoA: dt.stringifyExact(a),
}));