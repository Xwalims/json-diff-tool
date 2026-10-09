'use strict';

const { typeOf, encodePointer } = require('./pointer.js');

/**
 * Semantic diff between two JSON documents.
 *
 * The output is an RFC 6902-style operation list: `add`, `remove` and
 * `replace` entries carrying a JSON Pointer `path`. Object keys are visited
 * in sorted order so the output is byte-for-byte deterministic regardless of
 * key insertion order.
 *
 * @module diff
 */

/**
 * @typedef {object} DiffOptions
 * @property {'index'|'lcs'} [arrayMode='index'] Strategy used to compare
 *   arrays. `index` pairs up elements by position; `lcs` computes a longest
 *   common subsequence and reports genuine insertions and deletions.
 * @property {boolean} [includeOldValue=true] Attach `oldValue` to `replace`
 *   and `remove` operations.
 * @property {boolean} [includeValue=true] Attach `value` to `add` and
 *   `replace` operations.
 * @property {boolean} [cloneValues=true] Deep-copy emitted values so callers
 *   cannot mutate the inputs through the returned operations.
 */

/**
 * @typedef {object} DiffOperation
 * @property {'add'|'remove'|'replace'} op The operation kind.
 * @property {string} path JSON Pointer to the affected location.
 * @property {*} [value] The new value, for `add` and `replace`.
 * @property {*} [oldValue] The previous value, for `replace` and `remove`.
 */

/**
 * Default options, applied to any option left undefined by the caller.
 *
 * @type {Required<DiffOptions>}
 */
const DEFAULT_OPTIONS = Object.freeze({
  arrayMode: 'index',
  includeOldValue: true,
  includeValue: true,
  cloneValues: true,
});

/**
 * Normalise caller options and reject unknown array modes early.
 *
 * @param {DiffOptions} [options] Caller options.
 * @returns {Required<DiffOptions>} Fully resolved options.
 * @throws {TypeError} If `arrayMode` is not `index` or `lcs`.
 */
function resolveOptions(options = {}) {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  if (merged.arrayMode !== 'index' && merged.arrayMode !== 'lcs') {
    throw new TypeError(
      `arrayMode must be "index" or "lcs", received ${JSON.stringify(merged.arrayMode)}`
    );
  }
  return merged;
}

/**
 * Deep structural equality for JSON values.
 *
 * Object key order is irrelevant, so `{a:1,b:2}` equals `{b:2,a:1}`.
 *
 * NUMBERS. This is where a diff tool can be silently wrong. Two numbers are
 * equal when they are the same value, and for integers outside the IEEE-754
 * safe range that needs exact arithmetic rather than `===`:
 *
 *     parseExact('{"n":9007199254740993}')  // n === 9007199254740993n
 *     parseExact('{"n":9007199254740992}')  // n === 9007199254740992n
 *
 * Both are BigInt because `parseExact` keeps them exact, and `===` compares
 * BigInts by value, so they differ and a `replace` is emitted. Before that,
 * both had collapsed onto the same double and `a === b` reported the two
 * documents as identical. The comparison is only reached when the kinds
 * already match, so it cannot confuse a BigInt with a number.
 *
 * `===` is kept first and `==` is never used on purpose: `0 == 0n` is `true`
 * and `0 === 0n` is `false`, so a loose comparison would call an integer
 * document and a float document the same. A JSON number is one kind of thing
 * however it is spelled, but 0 and 0.0 have different literals and
 * distinguishing them here is consistent with treating 1 and 1.0 as the same
 * value (both are exactly 1).
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {boolean} `true` when the values are structurally identical.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  const kindA = typeOf(a);
  if (kindA !== typeOf(b)) return false;
  // Two BigInts: `===` already said no, and BigInt comparison is exact.
  if (kindA === 'bigint') return false;
  if (kindA === 'array') {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (kindA === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
    );
  }
  // Primitives, including null, were already compared for type and value.
  return false;
}

/**
 * Deep-copy a value unless the caller opted out.
 *
 * @param {*} value Value to copy.
 * @param {Required<DiffOptions>} options Resolved options.
 * @returns {*} An independent copy, or the original when `cloneValues` is false.
 */
function maybeClone(value, options) {
  return options.cloneValues ? structuredClone(value) : value;
}

/**
 * Build an `add` operation.
 *
 * @param {string} path JSON Pointer.
 * @param {*} value Value added.
 * @param {Required<DiffOptions>} options Resolved options.
 * @returns {DiffOperation} The operation.
 */
function addOp(path, value, options) {
  const op = { op: 'add', path };
  if (options.includeValue) op.value = maybeClone(value, options);
  return op;
}

/**
 * Build a `remove` operation.
 *
 * @param {string} path JSON Pointer.
 * @param {*} oldValue Value removed.
 * @param {Required<DiffOptions>} options Resolved options.
 * @returns {DiffOperation} The operation.
 */
function removeOp(path, oldValue, options) {
  const op = { op: 'remove', path };
  if (options.includeOldValue) op.oldValue = maybeClone(oldValue, options);
  return op;
}

/**
 * Build a `replace` operation.
 *
 * @param {string} path JSON Pointer.
 * @param {*} value New value.
 * @param {*} oldValue Previous value.
 * @param {Required<DiffOptions>} options Resolved options.
 * @returns {DiffOperation} The operation.
 */
function replaceOp(path, value, oldValue, options) {
  const op = { op: 'replace', path };
  if (options.includeValue) op.value = maybeClone(value, options);
  if (options.includeOldValue) op.oldValue = maybeClone(oldValue, options);
  return op;
}

/**
 * Diff two arrays position by position.
 *
 * Elements are paired on index. A shorter left array yields trailing `add`
 * operations; a longer left array yields trailing `remove` operations. This
 * strategy is O(n) and predictable, but it cannot recognise that an element
 * merely moved within the array.
 *
 * @param {Array} a Original array.
 * @param {Array} b Updated array.
 * @param {string} basePath Pointer prefix of the array.
 * @param {Required<DiffOptions>} options Resolved options.
 * @param {number} [offset=0] Index that `a[0]` occupies in the enclosing array.
 *   Callers that diff a slice of a larger array pass the slice start so emitted
 *   pointers address real positions.
 * @returns {DiffOperation[]} Operations for this array.
 */
function diffArrayByIndex(a, b, basePath, options, offset = 0) {
  const ops = [];
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const child = `${basePath}/${offset + i}`;
    const left = a[i];
    const right = b[i];
    const kindA = typeOf(left);
    const kindB = typeOf(right);
    if (kindA === kindB && (kindA === 'object' || kindA === 'array')) {
      ops.push(...diffValue(left, right, child, options));
    } else if (!deepEqual(left, right)) {
      ops.push(replaceOp(child, right, left, options));
    }
  }
  // Remaining elements are pure insertions or deletions.
  for (let i = shared; i < b.length; i += 1) {
    ops.push(addOp(`${basePath}/${offset + i}`, b[i], options));
  }
  // Removals are emitted in DESCENDING index order. Each splice shifts every
  // later element left by one, so removing high indexes first is what keeps
  // the remaining indexes valid when the patch is replayed in order.
  for (let i = a.length - 1; i >= shared; i -= 1) {
    ops.push(removeOp(`${basePath}/${offset + i}`, a[i], options));
  }
  return ops;
}

/**
 * Compute the pairs of indices that form a longest common subsequence of two
 * arrays, using a bottom-up dynamic programming table.
 *
 * @param {Array} a Original array.
 * @param {Array} b Updated array.
 * @returns {Array<[number, number]>} Matched `[leftIndex, rightIndex]` pairs in
 *   ascending order.
 */
function longestCommonSubsequence(a, b) {
  const n = a.length;
  const m = b.length;

  // table[i][j] is the LCS length of a[i..] and b[j..].
  const table = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) table[i] = new Array(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (deepEqual(a[i], b[j])) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }

  // Walk the table forward to recover the matched pairs.
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (deepEqual(a[i], b[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Diff two arrays using a longest common subsequence.
 *
 * Elements that are deeply equal anchor the LCS and cost nothing. The runs
 * between two anchors are compared position by position, so a container
 * element whose contents changed is still diffed internally instead of being
 * rewritten wholesale. Anything left over inside a run becomes a plain `add` or
 * `remove`. A prepend to a 100-element array therefore costs one `add` rather
 * than 100 `replace` operations.
 *
 * The LCS itself comes from a bottom-up dynamic programming table, which is
 * O(n * m) in time and space. No exponential backtracking is used.
 *
 * Emission is replay-safe. Operations are addressed against the array as it
 * exists while the patch runs, tracked with a running `shift` equal to
 * `adds - removes` so far:
 *
 * - paired elements keep their slot, since this segment's insertions and
 *   deletions all happen at or after that slot;
 * - deletions are emitted in DESCENDING index order, because each splice
 *   shifts every later element left by one;
 * - insertions are emitted in ASCENDING order at the gap's end position, which
 *   advances by one per insert as the shift grows.
 *
 * @param {Array} a Original array.
 * @param {Array} b Updated array.
 * @param {string} basePath Pointer prefix of the array.
 * @param {Required<DiffOptions>} options Resolved options.
 * @returns {DiffOperation[]} Operations for this array.
 */
function diffArrayByLcs(a, b, basePath, options) {
  if (a.length === 0 && b.length === 0) return [];

  const anchors = longestCommonSubsequence(a, b);
  const ops = [];

  // Running index offset: added minus removed so far, i.e. how far the array
  // has drifted from its original shape at the current point.
  let shift = 0;
  let leftCursor = 0;
  let rightCursor = 0;

  // Sentinel boundaries fold the leading and trailing runs into the same code
  // path as the runs between two anchors.
  const bounds = [...anchors, [a.length, b.length]];
  for (const [leftEnd, rightEnd] of bounds) {
    const leftCount = leftEnd - leftCursor;
    const rightCount = rightEnd - rightCursor;
    const shared = Math.min(leftCount, rightCount);

    // Paired elements keep their position, so this segment has not moved them.
    for (let p = 0; p < shared; p += 1) {
      const child = `${basePath}/${leftCursor + p + shift}`;
      const leftValue = a[leftCursor + p];
      const rightValue = b[rightCursor + p];
      const kindA = typeOf(leftValue);
      const kindB = typeOf(rightValue);
      if (kindA === kindB && (kindA === 'object' || kindA === 'array')) {
        ops.push(...diffValue(leftValue, rightValue, child, options));
      } else if (!deepEqual(leftValue, rightValue)) {
        ops.push(replaceOp(child, rightValue, leftValue, options));
      }
    }

    // Deletions run high index to low so each splice leaves the rest valid.
    for (let p = leftCount - 1; p >= shared; p -= 1) {
      ops.push(removeOp(`${basePath}/${leftCursor + p + shift}`, a[leftCursor + p], options));
    }
    shift -= leftCount - shared;

    // Insertions land after the paired elements, one slot apart.
    const insertAt = leftCursor + shared + shift;
    for (let p = shared; p < rightCount; p += 1) {
      ops.push(addOp(`${basePath}/${insertAt + (p - shared)}`, b[rightCursor + p], options));
    }
    shift += rightCount - shared;

    leftCursor = leftEnd + 1;
    rightCursor = rightEnd + 1;
  }

  return ops;
}

/**
 * Diff two values of any type.
 *
 * Two containers of the same kind are compared recursively. Values of
 * different kinds, and differing primitives, become a single `replace`.
 *
 * @param {*} a Original value.
 * @param {*} b Updated value.
 * @param {string} path JSON Pointer of `a`.
 * @param {Required<DiffOptions>} options Resolved options.
 * @returns {DiffOperation[]} Operations for this value.
 */
function diffValue(a, b, path, options) {
  const kindA = typeOf(a);
  const kindB = typeOf(b);

  if (kindA !== kindB) return [replaceOp(path, b, a, options)];

  if (kindA === 'array') {
    return options.arrayMode === 'lcs'
      ? diffArrayByLcs(a, b, path, options)
      : diffArrayByIndex(a, b, path, options);
  }

  if (kindA === 'object') {
    const ops = [];
    // Sorted union of keys keeps output deterministic.
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      // encodePointer returns a full "/key" segment including its separator,
      // so it composes with the parent prefix without adding another slash.
      const child = `${path}${encodePointer([key])}`;
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      if (inA && inB) {
        ops.push(...diffValue(a[key], b[key], child, options));
      } else if (inB) {
        ops.push(addOp(child, b[key], options));
      } else {
        ops.push(removeOp(child, a[key], options));
      }
    }
    return ops;
  }

  if (kindA === 'undefined') return [];

  return deepEqual(a, b) ? [] : [replaceOp(path, b, a, options)];
}

/**
 * Compute the operations that turn document `a` into document `b`.
 *
 * @param {*} a Original document.
 * @param {*} b Updated document.
 * @param {DiffOptions} [options] Diff options.
 * @returns {DiffOperation[]} Ordered, deterministic operation list; empty when
 *   the documents are equivalent.
 * @throws {TypeError} If `options.arrayMode` is invalid.
 *
 * @example
 * diff({ a: 1 }, { a: 2 });
 * // => [{ op: 'replace', path: '/a', value: 2, oldValue: 1 }]
 *
 * @example
 * // LCS mode sees a prepend as one insertion instead of N replacements.
 * diff([1, 2, 3], [0, 1, 2, 3], { arrayMode: 'lcs' });
 * // => [{ op: 'add', path: '/0', value: 0 }]
 */
function diff(a, b, options) {
  return diffValue(a, b, '', resolveOptions(options));
}

/**
 * Count operations by kind.
 *
 * @param {DiffOperation[]} operations Operation list.
 * @returns {{add: number, remove: number, replace: number, total: number}}
 *   Tally per operation kind plus the total.
 */
function summarize(operations) {
  const counts = { add: 0, remove: 0, replace: 0, total: operations.length };
  for (const operation of operations) {
    if (operation.op === 'add') counts.add += 1;
    else if (operation.op === 'remove') counts.remove += 1;
    else if (operation.op === 'replace') counts.replace += 1;
  }
  return counts;
}

module.exports = { diff, deepEqual, summarize, DEFAULT_OPTIONS };