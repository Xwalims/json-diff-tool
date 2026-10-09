#!/usr/bin/env python3
"""Differential check for json-diff-tool's exact-number handling.

GROUND TRUTH: Python's json module. It parses integers into exact Python
ints and floats into arbitrary-precision decimals, so it can always tell two
number literals apart -- which is precisely what a double-based parser
cannot.

Every pair below differs ONLY in a number. The property asserted is the one a
diff tool must never get wrong:

    the tool must report a difference  <=>  python says the documents differ

A tool that reports "identical" for two documents that differ is the worst
possible failure for a diff tool: it returns exit code 0, so a pipeline
gates on it and ships the wrong data.
"""
import json
import os
import random
import subprocess
import sys
import tempfile

TMPDIR = tempfile.mkdtemp(prefix="json-diff-numbers-")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The driver lives IN THE REPO, not in a scratch directory. It used to point at
# /home/user/.hermes/cache/scratch, which is pruned after 24h and is not in git,
# so the committed script failed for anyone but the machine that wrote it -- and
# silently, since a missing driver only showed up as a node error string.
DRIVER = os.path.join(ROOT, "scripts", "exact-number-driver.js")

# Which parse path to check: "auto" (whatever this runtime picks), "fast" (the
# reviver's raw-source context) or "portable" (the Node-20-safe rewrite).
#
# Both are checked against the same oracle, and that is not ceremony. The fast
# path depends on `JSON.parse`'s reviver context, which the declared Node 20
# floor may not provide; the portable path is what would run there. Verifying
# only the fast path would let the fix evaporate silently on the oldest
# supported runtime.
MODE = sys.argv[1] if len(sys.argv) > 1 else "auto"

CASES = [
    # (label, A, B)
    ("2^53 vs 2^53+1", '{"n":9007199254740992}', '{"n":9007199254740993}'),
    ("2^53-1 vs 2^53", '{"n":9007199254740991}', '{"n":9007199254740992}'),
    ("2^63 vs 2^63+1", '{"n":9223372036854775808}', '{"n":9223372036854775809}'),
    ("1e17 vs +1", '{"n":100000000000000000}', '{"n":100000000000000001}'),
    ("1e18 vs +1", '{"n":1000000000000000000}', '{"n":1000000000000000001}'),
    ("snowflake ids", '{"id":123456789012345678}', '{"id":123456789012345679}'),
    ("100-digit ints",
     '{"n":' + '1' + '0' * 100 + '}', '{"n":' + '1' + '0' * 99 + '1' + '}'),
    ("negative bigs", '{"n":-9007199254740993}', '{"n":-9007199254740992}'),
    ("nested", '{"a":{"b":[9007199254740993]}}', '{"a":{"b":[9007199254740992]}}'),
    # -- these must be reported IDENTICAL: same value, different spelling --
    ("same value, equal spelling", '{"n":42}', '{"n":42}'),
    ("1 vs 1.0", '{"n":1}', '{"n":1.0}'),
    ("max safe int", '{"n":9007199254740991}', '{"n":9007199254740991}'),
    ("fraction unchanged", '{"n":1.5}', '{"n":1.5}'),
]


def random_pairs(count, seed):
    """Random big-integer neighbours: exactly the shape the bug hides in."""
    rnd = random.Random(seed)
    out = []
    for _ in range(count):
        digits = rnd.randint(17, 40)
        base = rnd.randint(10 ** (digits - 1), 10 ** digits - 1)
        if rnd.random() < 0.5:
            base += rnd.choice([1, 2, 3])
        else:
            base -= rnd.choice([1, 2, 3])
        if rnd.random() < 0.3:
            base = -base
        path = rnd.choice(['/n', '/a/b', '/list/0', '/deep/x/y/z'])
        doc_a = '{"n":%d}' % base
        doc_b = '{"n":%d}' % (base + rnd.choice([1, 2, -1, -2]))
        out.append(("random neighbour %s" % path, doc_a, doc_b))
    return out


def node_version():
    """The node version driving the tool under test."""
    p = subprocess.run(["node", "--version"], capture_output=True, text=True)
    return p.stdout.strip() or "?"


def run_diff(left, right):
    lp = os.path.join(TMPDIR, "_l.json")
    rp = os.path.join(TMPDIR, "_r.json")
    with open(lp, "w") as fh:
        fh.write(left)
    with open(rp, "w") as fh:
        fh.write(right)
    p = subprocess.run(["node", DRIVER, lp, rp, MODE], capture_output=True, text=True)
    if p.returncode != 0:
        lines = (p.stderr or "").strip().splitlines()
        return {"error": lines[-1] if lines else "?"}
    return json.loads(p.stdout)


fail = 0
checked = 0
pairs = CASES + random_pairs(300, seed=20261009)

for label, l, r in pairs:
    # Python decides ground truth first, on identical bytes.
    exact_differ = json.loads(l) != json.loads(r)
    res = run_diff(l, r)
    if "error" in res:
        # A driver that refuses the requested path is NOT a diff mismatch. Report
        # it as its own outcome so it cannot be mistaken for one, or for a pass.
        if "reviver context" in res["error"]:
            print("mode %r cannot run on this runtime (node %s); nothing checked"
                  % (MODE, node_version()))
            sys.exit(2)
        print("ERROR  %-30s %s" % (label, res["error"]))
        fail += 1
        continue
    checked += 1
    ops = res["ops"]
    reported_differ = len(ops) > 0
    if exact_differ != reported_differ:
        fail += 1
        print("BUG    %-30s python=%s tool=%s (%d ops)"
              % (label, "differ" if exact_differ else "equal",
                 "differ" if reported_differ else "IDENTICAL", len(ops)))
        print("         A: %s" % l)
        print("         B: %s" % r)
    elif res.get("echoA") != l:
        # The value must survive the round trip out as well as in: a tool that
        # detects the difference and then prints the rounded number has not
        # fixed anything.
        fail += 1
        print("BUG    %-30s re-emit changed document A: %s != %s"
              % (label, res.get("echoA"), l))

print("checked %d pairs against python's json; %d failures" % (checked, fail))
sys.exit(1 if fail else 0)