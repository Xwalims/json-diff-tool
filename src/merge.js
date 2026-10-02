'use strict';

const { typeOf } = require('./pointer.js');

/**
 * Deep merge of JSON documents.
 *
 * Objects merge key by key; arrays and scalars follow an explicit policy
 * rather than an implicit one.
 *
 * @module merge
 */

/**
 * @typedef {object} MergeOptions
 * @property {'replace'|'concat'|'union'} [arrayPolicy='replace'] How to combine
 *   two arrays. `replace` takes the incoming array, `concat` appends it after
 *   the base, `union` appends only entries that are not already present
 *   (compared structurally).
 * @property {'overwrite'|'ignore'|'keep'} [nullPolicy='overwrite'] How to treat
 *   an incoming `null`. `overwrite` replaces the base value, `ignore` leaves
 *   the base untouched, `keep` is an alias of `ignore` that reads more clearly
 *   for "the incoming null carries no information".
 */

/**
 * @typedef {object} MergeConflict
 * @property {string} path JSON Pointer of the conflicting value.
 * @property {'array'|'null'} kind Why the merge was not a plain object merge.
 * @property {*} base Base value.
 * @property {*} incoming Incoming value.
 * @property {'replace'|'concat'|'union'|'ignore'} resolution What was done.
 */

const ARRAY_POLICIES = new Set(['replace', 'concat', 'union']);
const NULL_POLICIES = new Set(['overwrite', 'ignore', 'keep']);

/**
 * Normalise options and reject unknown policy names early.
 *
 * @param {MergeOptions} [options] Caller options.
 * @returns {Required<MergeOptions>} Fully resolved options.
 * @throws {TypeError} If either policy is unknown.
 */
function resolveOptions(options = {}) {
  const merged = { arrayPolicy: 'replace', nullPolicy: 'overwrite', ...options };
  if (!ARRAY_POLICIES.has(merged.arrayPolicy)) {
    throw new TypeError(
      `arrayPolicy must be one of ${[...ARRAY_POLICIES].join(', ')}, received ${JSON.stringify(merged.arrayPolicy)}`
    );
  }
  if (!NULL_POLICIES.has(merged.nullPolicy)) {
    throw new TypeError(
      `nullPolicy must be one of ${[...NULL_POLICIES].join(', ')}, received ${JSON.stringify(merged.nullPolicy)}`
    );
  }
  return merged;
}

/**
 * Structural equality used by the `union` array policy.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {boolean} `true` when the values are deeply equal.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  const kindA = typeOf(a);
  if (kindA !== typeOf(b)) return false;
  if (kindA === 'array') {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (kindA === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Combine two arrays under the configured policy.
 *
 * @param {Array} base Base array.
 * @param {Array} incoming Incoming array.
 * @param {Required<MergeOptions>} options Resolved options.
 * @returns {Array} The merged array, always a new array.
 */
function mergeArrays(base, incoming, options) {
  switch (options.arrayPolicy) {
    case 'concat':
      return [...base, ...incoming];
    case 'union': {
      const result = [...base];
      for (const item of incoming) {
        if (!result.some((existing) => deepEqual(existing, item))) result.push(item);
      }
      return result;
    }
    case 'replace':
    default:
      return [...incoming];
  }
}

/**
 * Deep-merge `incoming` onto `base` and return a new document.
 *
 * Objects merge recursively. Scalars take the incoming value. Arrays follow
 * `arrayPolicy`, and an incoming `null` follows `nullPolicy`. Neither input is
 * mutated.
 *
 * @param {*} base Baseline document.
 * @param {*} incoming Document whose values win, subject to the policies.
 * @param {MergeOptions & {onConflict?: (conflict: MergeConflict) => void}} [options]
 *   Merge options. `onConflict` is called once for every array or `null` that
 *   had to be resolved by policy rather than by object recursion.
 * @returns {*} The merged document.
 * @throws {TypeError} If either policy name is unknown.
 *
 * @example
 * merge({ a: 1, list: [1] }, { b: 2 }, { arrayPolicy: 'concat' });
 * // => { a: 1, b: 2, list: [1] }
 */
function merge(base, incoming, options = {}) {
  const { onConflict, ...policies } = options;
  const resolved = resolveOptions(policies);

  /**
   * @param {*} baseValue Value from the base document.
   * @param {*} incomingValue Value from the incoming document.
   * @param {string} path JSON Pointer of the current location.
   * @returns {*} The merged value.
   */
  function mergeValue(baseValue, incomingValue, path) {
    // An explicit null in the incoming document is treated as a decision, so
    // the policy decides rather than object recursion.
    if (incomingValue === null) {
      if (resolved.nullPolicy === 'overwrite') {
        if (onConflict) {
          onConflict({ path, kind: 'null', base: baseValue, incoming: null, resolution: 'overwrite' });
        }
        return null;
      }
      if (onConflict) {
        onConflict({ path, kind: 'null', base: baseValue, incoming: null, resolution: 'ignore' });
      }
      return structuredClone(baseValue);
    }

    if (typeOf(baseValue) === 'object' && typeOf(incomingValue) === 'object') {
      const result = structuredClone(baseValue);
      for (const key of Object.keys(incomingValue)) {
        const childPath = `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (Object.prototype.hasOwnProperty.call(result, key)) {
          result[key] = mergeValue(result[key], incomingValue[key], childPath);
        } else {
          result[key] = structuredClone(incomingValue[key]);
        }
      }
      return result;
    }

    if (typeOf(baseValue) === 'array' && typeOf(incomingValue) === 'array') {
      if (onConflict) {
        onConflict({
          path,
          kind: 'array',
          base: baseValue,
          incoming: incomingValue,
          resolution: resolved.arrayPolicy,
        });
      }
      return mergeArrays(baseValue, incomingValue, resolved);
    }

    // Scalars and type changes simply take the incoming value.
    return structuredClone(incomingValue);
  }

  return mergeValue(base, incoming, '');
}

module.exports = { merge, deepEqual };
