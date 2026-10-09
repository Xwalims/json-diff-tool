# json-diff-tool

Semantic diff and merge for JSON documents. Produces RFC 6902-style operations
addressed by JSON Pointer (RFC 6901), and can apply a patch back to a document.
Zero runtime dependencies.

<!-- hero -->

[![CI](https://github.com/Xwalims/json-diff-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/json-diff-tool/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [What it is](#what-it-is)
- [Usage](#usage)
  - [Array strategies](#array-strategies)
  - [Machine output and patch files](#machine-output-and-patch-files)
  - [Merging](#merging)
- [Operation semantics](#operation-semantics)
  - [`diff(a, b, options?)`](#diffa-b-options)
- [A note on numbers larger than 2^53](#a-note-on-numbers-larger-than-253)
- [A note on `__proto__`](#a-note-on-__proto__)
- [License](#license)

<!-- /hero -->

## What it is

- `diff(a, b)` returns an ordered array of `add`, `remove` and `replace`
  operations. Object keys are visited in sorted order, so output does not depend
  on key insertion order.
- Two array strategies: `index` pairs elements by position and is O(n);
  `lcs` computes a real longest common subsequence so an insertion costs one
  operation instead of rewriting everything after it.
- `applyPatch(doc, ops)` replays a patch on a deep copy and validates every
  operation first, so a patch that fails late cannot leave a half-applied
  document.
- `merge(base, incoming, options)` deep-merges two documents with explicit
  policies for arrays and nulls.
- A CLI with meaningful exit codes for use in scripts and CI.

## Why

JSON has no standard diff format in wide use, so comparing two config files
usually means a line-oriented diff that reports every line of a reformatted
file as changed, and says nothing useful about a reordered array. This tool
compares values, not text: reformatting produces no operations, and a changed
value is reported once at its exact path.

It also ships the apply side. A diff you cannot replay is only half a tool, and
hand-writing the patch application is where the interesting bugs live: applying
an `add` to an array must shift elements, applying a `remove` must not invalidate
the indexes of the operations that follow it. Those rules are implemented and
tested here rather than left to the caller.

## Install

No dependencies, so a clone and a Node.js 20 or newer is all that is needed:

```bash
git clone https://github.com/Xwalims/json-diff-tool.git
cd json-diff-tool
node --test        # verify it works
```

To use the CLI without installing:

```bash
node bin/json-diff.js A.json B.json
```

Or link it onto your `PATH` from a checkout. This package is **not published to
npm** — the name is unregistered, so `npm install -g json-diff-tool` fails:

```bash
git clone https://github.com/Xwalims/json-diff-tool.git
cd json-diff-tool
npm link          # provides the `json-diff` command
```

## Usage

Given `a.json`:

```json
{
  "service": "api",
  "replicas": 2,
  "image": { "repo": "acme/api", "tag": "1.0.0" },
  "env": { "LOG_LEVEL": "info", "REGION": "eu-west-1" },
  "hosts": ["a.example.com", "b.example.com"]
}
```

and `b.json`:

```json
{
  "service": "api",
  "replicas": 4,
  "image": { "repo": "acme/api", "tag": "1.1.0" },
  "env": { "LOG_LEVEL": "debug" },
  "hosts": ["a.example.com", "b.example.com", "c.example.com"]
}
```

`json-diff a.json b.json --array-mode lcs` prints:

```text
added (1):
  + /hosts/2        = "c.example.com"

changed (3):
  ~ /env/LOG_LEVEL  "info" -> "debug"
  ~ /image/tag      "1.0.0" -> "1.1.0"
  ~ /replicas       2 -> 4

removed (1):
  - /env/REGION     "eu-west-1"

5 operations: 1 added, 3 changed, 1 removed
```

Identical documents exit 0 and print `no differences`. A reformatted but
equivalent document behaves the same way, because the comparison is structural.

### Array strategies

This is the one place the choice matters. Prepending `0` to a six-element
array:

`--array-mode index` (the default) pairs by position, so every element looks
like a change:

```text
added (1):
  + /6  = 6

changed (6):
  ~ /0  1 -> 0
  ~ /1  2 -> 1
  ~ /2  3 -> 2
  ~ /3  4 -> 3
  ~ /4  5 -> 4
  ~ /5  6 -> 5

7 operations: 1 added, 6 changed, 0 removed
```

`--array-mode lcs` matches the shared elements and reports the real edit:

```text
added (1):
  + /0  = 0

1 operation: 1 added, 0 changed, 0 removed
```

Use `index` for arrays where position is meaningful, such as ordered tuples.
Use `lcs` for arrays of records or sets, where an inserted item should not
read as a rewrite of everything after it.

### Machine output and patch files

`--json` writes the raw operation array, and `--out` writes it to a file:

```bash
json-diff a.json b.json --array-mode lcs --json > patch.json
json-diff a.json b.json --array-mode lcs --out patch.json
```

Both are valid input to `applyPatch`. In scripts, exit 1 with `--quiet` is
enough to branch on "did these change":

```bash
if json-diff a.json b.json --quiet; then
  echo "identical"
else
  echo "they differ"
fi
```

### Merging

`--merge` deep-merges the second document onto the first instead of diffing:

```bash
json-diff base.json overlay.json --merge --merge-array concat
```

## Operation semantics

Operations are applied strictly in order. Every `path` is a JSON Pointer;
`~` and `/` inside a key are escaped as `~0` and `~1`.

| Operation | Meaning | Value columns |
| --- | --- | --- |
| `add` | Insert at `path`. In an object this creates or overwrites the key; in an array it splices the value in and shifts later elements right. The token `-` appends. | `value` |
| `remove` | Delete the value at `path`. In an array the remaining elements shift left. | `oldValue` |
| `replace` | Overwrite an existing value. The path must already exist. | `value`, `oldValue` |

Two consequences of "in order" are worth stating plainly, because they decide
which strategy you want:

- Array `add` and `remove` change the indexes of later operations. Deletions
  are therefore emitted from the highest index down, and insertions from the
  lowest up, so replaying the list in order is always correct.
- In `lcs` mode a matched element keeps its position only because everything
  this segment adds or removes happens at or after it.

Comparing objects follows sorted key order. Keys only in the right document are
`add`, keys only in the left are `remove`, shared keys recurse, and two values
of different JSON types collapse to one `replace` instead of being descended
into.

## CLI flags

| Flag | Default | Description |
| --- | --- | --- |
| `--array-mode <index\|lcs>` | `index` | How to compare arrays. `index` pairs by position; `lcs` matches shared elements. |
| `--json` | off | Emit the machine-readable JSON operation array on stdout. |
| `--no-values` | off | Print paths only, omit the value column. |
| `--quiet` | off | Print nothing; use the exit code. |
| `--out <PATCH.json>` | none | Write the JSON operation array to a file. Parent directories are created. |
| `--merge` | off | Deep-merge B onto A and print the merged document instead of diffing. |
| `--merge-array <policy>` | `replace` | Arrays during `--merge`: `replace`, `concat` or `union` (structural dedupe). |
| `--merge-null <policy>` | `overwrite` | Nulls during `--merge`: `overwrite`, `ignore` or `keep`. |
| `-h`, `--help` | | Show usage and exit 0. |
| `-v`, `--version` | | Print the version and exit 0. |

Either document path may be `-` to read that document from stdin.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | The documents are equivalent. |
| 1 | Differences were found. |
| 2 | Usage, IO or parse error. |

## Library API

```js
const { diff, applyPatch, merge, formatOps } = require('json-diff-tool');

const before = { replicas: 2, hosts: ['a', 'b'], env: { LOG: 'info' } };
const after = { replicas: 4, hosts: ['a', 'b', 'c'], env: { LOG: 'debug' } };

const ops = diff(before, after, { arrayMode: 'lcs' });
// [ { op: 'replace', path: '/env/LOG', value: 'debug', oldValue: 'info' },
//   { op: 'add', path: '/hosts/2', value: 'c' },
//   { op: 'replace', path: '/replicas', value: 4, oldValue: 2 } ]

applyPatch(before, ops) === after;  // deepEqual, true
```

### `diff(a, b, options?)`

Returns the operation list, empty when the documents are equivalent.

| Option | Default | Description |
| --- | --- | --- |
| `arrayMode` | `'index'` | `'index'` or `'lcs'`. |
| `includeValue` | `true` | Attach `value` to `add` and `replace`. |
| `includeOldValue` | `true` | Attach `oldValue` to `replace` and `remove`. |
| `cloneValues` | `true` | Deep-copy emitted values so callers cannot alias the inputs. |

Also exported: `deepEqual(a, b)` for structural comparison, and
`summarize(ops)` returning `{ add, remove, replace, total }`.

### `applyPatch(doc, ops, options?)`

Returns a patched deep copy. Pass `{ inPlace: true }` to mutate the input
instead. The whole patch is validated before anything is written, so a failure
leaves the input untouched. Errors name the failing operation index and path,
and carry `operationIndex` and `operation` properties.

### `merge(base, incoming, options?)`

Returns a new merged document; neither input is mutated.

| Option | Default | Description |
| --- | --- | --- |
| `arrayPolicy` | `'replace'` | `replace` takes the incoming array, `concat` appends it, `union` appends only structurally new entries. |
| `nullPolicy` | `'overwrite'` | `overwrite` applies an incoming null, `ignore` (or `keep`) leaves the base value. |
| `onConflict` | none | Called with `{ path, kind, base, incoming, resolution }` for every value resolved by policy. |

### `formatOps(ops, options?)`

Renders the grouped, aligned text format. `showValues: false` prints paths
only, `maxValueLength: 0` disables truncation of long values, and `indent`
controls the JSON machine format. `formatJson`, `formatSummary` and `format`
are also exported.

### `pointer`

The RFC 6901 helpers the rest is built on: `get`, `has`, `set` (overwrite),
`insert` (splice, for `add`), `remove`, `encodePointer`, `decodePointer`,
`escapeToken`, `unescapeToken` and `toArrayIndex`. `assignKey` is the write
helper those use; see the note below.

## A note on numbers larger than 2^53

`JSON.parse` sends every number through an IEEE-754 double, so it cannot hold
an integer above 2^53-1. Two different documents become one value:

```js
JSON.parse('{"id":9007199254740993}').id === JSON.parse('{"id":9007199254740992}').id
// true   -- different IDs, one value
```

For a diff tool that is the worst failure available: `diff` returns no
operations, the CLI prints `no differences` and exits **0**, so any pipeline
gating on that exit code ships the wrong data. The CLI reads with `parseExact`
and writes with `stringifyExact`, which keep such integers exact:

```console
$ node bin/json-diff.js a.json b.json
changed (1):
  ~ /id  9007199254740993 -> 9007199254740992

1 operation: 0 added, 1 changed, 0 removed
$ echo $?
1
```

Library callers get the same two functions, alongside `diff` and `merge`:

```js
const { parseExact, stringifyExact } = require('json-diff-tool');

const a = parseExact('{"id":9007199254740993}');
typeof a.id;            // 'bigint'
stringifyExact(a);      // '{"id":9007199254740993}'   <- exact, not rounded
```

**Only integers are affected.** A number with a fraction or an exponent — `1.5`,
`1e17` — is a real floating-point value and is left alone. Integers inside the
safe range stay plain `number`, so `typeof`, arithmetic and every existing
document behave exactly as before; `stringifyExact` is byte-identical to
`JSON.stringify` for a document that contains no large integer, and returns it
through the builtin unchanged. This widens what the tool can see. It does not
change what it reports for ordinary input.

Two things to know before building on it:

- An exact integer is a **`bigint`**, so `===` against a number is false even
  for equal values. `BigInt(5) === 5` is `false`; compare with `==`, coerce
  first, or keep the value as a string. `structuredClone` preserves `bigint`,
  so the values survive the deep copies this library makes internally.
- Feeding a `bigint` to plain `JSON.stringify` **throws** `TypeError`. Use
  `stringifyExact` for any value that came out of `parseExact`.

A `bigint` is written as a bare literal, not a quoted string. That is not an
accident of formatting: a `JSON.stringify` replacer returns a *value*, so
`typeof v === 'bigint' ? String(v) : v` produces `{"id":"9007…"}` — a string.
`JSON.rawJSON` can emit a raw token but is Node 22+ and does not survive
`structuredClone`, so the emitter is written by hand and delegates all string
escaping back to `JSON.stringify`.

The exact-number behaviour is checked against **Python's `json` module** as an
external oracle — it keeps integers exact, so it can always tell two literals
apart — over 313 pairs of large-integer neighbours:

```console
$ python3 scripts/cross-check-numbers.py portable
checked 313 pairs against python's json; 0 failures
```

`portable` is worth running specifically: the fast path needs `JSON.parse`'s
reviver context, which the declared Node 20 floor does not provide, so on the
oldest supported runtime a *different* parser runs. Both paths are checked.
`scripts/verify-exact-number-regression.sh` reverts each half of the fix in turn
and requires the suite to go red, failing loudly if a revert did not actually
change the code.

## A note on `__proto__`

`JSON.parse('{"__proto__": {...}}')` stores a key literally named
`__proto__` as an ordinary own data property, so a parsed document can
legitimately contain one. JavaScript's `=` operator does not agree:
`obj[key] = value` with `key === '__proto__'` invokes the inherited accessor
on `Object.prototype` and *retargets the prototype* instead of creating a
property. The value disappears from the document while the object still
appears to work, which is the worst failure mode there is:

```js
const after = JSON.parse('{"__proto__":{"role":"admin"}}');   // a key really exists
const out = applyPatch({}, diff({}, after));

JSON.stringify(out);   // '{"__proto__":{"role":"admin"}}'  <- preserved
out.role;              // undefined                       <- a property, not inherited
Object.keys(out);      // ['__proto__']
```

The same two lines with a hand-rolled `out['__proto__'] = after.__proto__`
instead of `applyPatch` produce `'{}'`, `[]` and an inherited `role` — the key
is gone from the document while the object still looks right. Note also that
the input has to come from `JSON.parse`: an object literal
`{ __proto__: { role: 'admin' } }` sets the prototype and never creates a key,
so it cannot express this document at all.

Every write path in this library goes through `assignKey`, which defines the
property when the token is `__proto__` and assigns normally otherwise, so the
result is byte-identical to what `JSON.parse` would have produced. Reads were
already safe: `get` and `has` use `hasOwnProperty` and never walk the
prototype chain. `test/proto-key.test.js` pins the behaviour, including that
`diff` + `applyPatch` round-trips a document that gains or loses such a key.

## Running tests

```bash
node --test
```

No test framework to install: the suite uses the built-in `node:test` runner.
The CLI tests spawn `bin/json-diff.js` in a child process and assert on real
stdout and real exit codes, so the shipped entry point is covered rather than
just the library behind it.

Expected output:

```text
ℹ tests 154
ℹ suites 0
ℹ pass 154
ℹ fail 0
```

CI runs the suite on Node.js 20, 22 and 24.

## License

MIT. See [LICENSE](LICENSE).
