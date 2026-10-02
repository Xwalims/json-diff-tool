# json-diff-tool

Semantic diff and merge for JSON documents. Produces RFC 6902-style operations
addressed by JSON Pointer (RFC 6901), and can apply a patch back to a document.
Zero runtime dependencies.

<!-- hero -->

[![CI](https://github.com/json-diff-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/json-diff-tool/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [What it is](#what-it-is)
- [Why](#why)
- [Install](#install)
- [Usage](#usage)
  - [Array strategies](#array-strategies)
  - [Machine output and patch files](#machine-output-and-patch-files)
  - [Merging](#merging)
- [Operation semantics](#operation-semantics)
- [CLI flags](#cli-flags)
- [Library API](#library-api)
  - [`diff(a, b, options?)`](#diffa-b-options)
  - [`applyPatch(doc, ops, options?)`](#applypatchdoc-ops-options)
  - [`merge(base, incoming, options?)`](#mergebase-incoming-options)
  - [`formatOps(ops, options?)`](#formatopsops-options)
  - [`pointer`](#pointer)
- [Running tests](#running-tests)
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
git clone <repository-url>
cd json-diff-tool
node --test        # verify it works
```

To use the CLI without installing:

```bash
node bin/json-diff.js A.json B.json
```

Or install it onto your `PATH`:

```bash
npm install -g json-diff-tool
json-diff A.json B.json
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
`escapeToken`, `unescapeToken` and `toArrayIndex`.

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
ℹ tests 140
ℹ suites 0
ℹ pass 140
ℹ fail 0
```

CI runs the suite on Node.js 20, 22 and 24.

## License

MIT. See [LICENSE](LICENSE).
