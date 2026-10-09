#!/usr/bin/env bash
# Prove the exact-number tests fail on a revert of the fix, and pass with it.
#
# A regression test that passes on the broken code is worse than no test: it
# certifies the bug. This reverts each half of the fix in turn and requires the
# suite to go red.
#
# EVERY REVERT IS ASSERTED TO HAVE CHANGED THE FILE BEFORE THE SUITE RUNS.
# That check is not decoration. `sed -i 's/pattern/replacement/'` that matches
# nothing exits 0, leaves the code untouched, and the suite stays green -- and
# this script then reports "NOT DETECTED -- test is useless", blaming the tests
# for a mutation that never happened. That is how a genuinely broken harness
# produces a confident wrong conclusion. An earlier version of this file did
# exactly that: its revert-2 pattern no longer matched the current source, and
# it printed "test is useless" about a suite that was never actually broken.
set -uo pipefail
REPO=/home/user/github-projects/json-diff-tool
cd "$REPO" || exit 1

fail=0
run_suite() { npm test 2>&1 | grep -E '^# (pass|fail)|^ℹ (pass|fail)' | tr '\n' ' '; }

# mutate <file> <python-replacement-expr>
# Applies an exact string replacement and FAILS LOUDLY if it changed nothing.
mutate() {
  local target="$1" old="$2" new="$3"
  local before
  before=$(sha256sum "$target" | cut -d' ' -f1)
  python3 - "$target" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if old not in s:
    sys.stderr.write("PATTERN NOT FOUND in %s:\n  %r\n" % (path, old))
    sys.exit(3)
open(path, 'w').write(s.replace(old, new, 1))
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  MUTATION FAILED (pattern not found) -- the revert below proves nothing"
    fail=1
    return 1
  fi
  local after
  after=$(sha256sum "$target" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then
    echo "  MUTATION WAS A NO-OP -- the revert below proves nothing"
    fail=1
    return 1
  fi
  return 0
}

expect_red() {
  local label="$1" out
  out=$(run_suite); echo "  $out"
  if echo "$out" | grep -q 'fail 0'; then
    echo "  NOT DETECTED -- the mutation was real but no test caught it"
    fail=1
  else
    echo "  detected (good)"
  fi
}

echo "=== baseline (fix present)"
base=$(run_suite); echo "  $base"
echo "$base" | grep -q 'fail 0' || { echo "  BASELINE IS RED"; fail=1; }

echo
echo "=== revert 1: cli.js + format.js back to JSON.parse / JSON.stringify"
cp src/cli.js /tmp/cli.keep; cp src/format.js /tmp/format.keep
r1=0
mutate src/cli.js 'const { parseExact, stringifyExact } = require' 'const _unused = require' || r1=1
mutate src/cli.js 'return parseExact(text);' 'return JSON.parse(text);' || r1=1
mutate src/format.js 'text = stringifyExact(value) ?? String(value);' 'text = JSON.stringify(value) ?? String(value);' || r1=1
[ "$r1" -eq 0 ] && expect_red "revert 1"
cp /tmp/cli.keep src/cli.js; cp /tmp/format.keep src/format.js

echo
echo "=== revert 2: the fast path stops upgrading to BigInt"
cp src/json-number.js /tmp/jn.keep
# Any change that makes parseExact lose large integers will do; the point is to
# make the fast path behave like plain JSON.parse.
if mutate src/json-number.js \
    'if (Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;' \
    'if (Math.abs(value) <= Number.MAX_SAFE_INTEGER * 2) return value;'; then
  expect_red "revert 2"
fi
cp /tmp/jn.keep src/json-number.js

echo
echo "=== revert 3: stringifyExact uses the string replacer (quotes the number)"
cp src/json-number.js /tmp/jn.keep
if mutate src/json-number.js \
    "  if (!containsBigInt(value)) return JSON.stringify(value, null, indent);
  return write(value, normalizeIndent(indent), '');" \
    "  return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v), indent);"; then
  expect_red "revert 3"
fi
cp /tmp/jn.keep src/json-number.js

echo
echo "=== revert 4: deepEqual loose-compares numbers (== instead of ===)"
cp src/diff.js /tmp/diff.keep
if mutate src/diff.js 'function deepEqual(a, b) {
  if (a === b) return true;' 'function deepEqual(a, b) {
  if (a == b) return true;'; then
  expect_red "revert 4"
fi
cp /tmp/diff.keep src/diff.js

echo
echo "=== revert 5: the portable parser itself loses large integers"
cp src/json-number.js /tmp/jn.keep
# NOT "point the driver at the wrong path". Both paths are required to agree, so
# calling the fast one instead is a no-op and proves nothing -- it only shows
# the two paths are interchangeable, which is the intent of the design. To
# prove the oracle really covers the portable path, break THAT path.
if mutate src/json-number.js \
    'if (!Number.isFinite(asDouble) || Math.abs(asDouble) > Number.MAX_SAFE_INTEGER) {' \
    'if (false) {'; then
  out=$(python3 scripts/cross-check-numbers.py portable 2>&1 | tail -3); echo "  portable: $out"
  if echo "$out" | grep -q '0 failures'; then
    echo "  NOT DETECTED -- the oracle does not actually cover the portable path"
    fail=1
  else
    echo "  detected (good)"
  fi
  out=$(python3 scripts/cross-check-numbers.py auto 2>&1 | tail -3); echo "  auto:     $out"
  if echo "$out" | grep -q '0 failures'; then
    echo "  auto also unaffected (expected: auto takes the fast path on this node)"
  else
    echo "  auto also failed (unexpected but not a problem)"
  fi
fi
cp /tmp/jn.keep src/json-number.js

echo
echo "=== restore check (fix back in place)"
out=$(run_suite); echo "  $out"
echo "$out" | grep -q 'fail 0' || { echo "  DID NOT RESTORE"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then echo "VERIFIED: every revert is caught, fix restores green"; else echo "PROBLEM: see above"; fi
exit "$fail"