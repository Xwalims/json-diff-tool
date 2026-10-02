'use strict';

const pointer = require('./pointer.js');

/**
 * Patch application for the operation lists produced by {@link module:diff}.
 *
 * @module apply
 */

/**
 * @typedef {object} ApplyOptions
 * @property {boolean} [inPlace=false] Mutate `doc` instead of working on a
 *   deep copy. The default keeps the caller's document untouched.
 */

/**
 * @typedef {import('./diff.js').DiffOperation} DiffOperation
 */

const VALID_OPS = new Set(['add', 'remove', 'replace']);

/**
 * Reject malformed operations before anything is mutated.
 *
 * Validation happens up front on purpose: a patch that is only wrong at
 * operation 7 must not leave the first six edits applied to the caller's
 * document.
 *
 * @param {DiffOperation[]} operations Operations to check.
 * @throws {TypeError} If `operations` is not an array or an entry is not an object.
 * @throws {Error} If an entry has an unknown `op` or a malformed `path`.
 * @throws {Error} If an `add` or `replace` is missing its `value`.
 */
function validateOperations(operations) {
  if (!Array.isArray(operations)) {
    throw new TypeError(
      `patch must be an array of operations, received ${operations === null ? 'null' : typeof operations}`
    );
  }
  operations.forEach((operation, index) => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      throw new TypeError(`operation ${index}: expected an object, received ${JSON.stringify(operation)}`);
    }
    if (!VALID_OPS.has(operation.op)) {
      throw new Error(
        `operation ${index}: unknown op ${JSON.stringify(operation.op)}; expected "add", "remove" or "replace"`
      );
    }
    if (typeof operation.path !== 'string') {
      throw new Error(
        `operation ${index}: path must be a string, received ${JSON.stringify(operation.path)}`
      );
    }
    // Surfaces malformed pointers and bad "~" escapes before any mutation.
    pointer.decodePointer(operation.path);
    if ((operation.op === 'add' || operation.op === 'replace') && !('value' in operation)) {
      throw new Error(`operation ${index}: ${operation.op} at ${JSON.stringify(operation.path)} requires a value`);
    }
  });
}

/**
 * Apply a patch to a document and return the result.
 *
 * Operations are applied strictly in order, so a patch that reorders array
 * elements must address indexes as they stand when each operation runs. The
 * input document is deep-copied first unless `inPlace` is set, so the caller's
 * document is never modified by default.
 *
 * @param {*} doc Document to patch.
 * @param {DiffOperation[]} operations Operations from {@link module:diff}.
 * @param {ApplyOptions} [options] Apply options.
 * @returns {*} The patched document, or the replacement value when an
 *   operation addresses the whole document with an empty pointer.
 * @throws {TypeError} If `operations` is not an array of objects.
 * @throws {Error} If an operation is malformed, if a `remove` or `replace`
 *   targets a path that does not exist, or if an array index is out of range.
 *   The message names the failing operation index and path.
 *
 * @example
 * applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }]);
 * // => { a: 2 }
 */
function applyPatch(doc, operations, options = {}) {
  validateOperations(operations);

  let current = options.inPlace ? doc : structuredClone(doc);

  operations.forEach((operation, index) => {
    // The empty pointer addresses the whole document, so it replaces the root.
    if (operation.path === '') {
      if (operation.op === 'remove') {
        throw new Error(
          `operation ${index}: remove at "" is not allowed, a patch cannot delete the root document`
        );
      }
      current = structuredClone(operation.value);
      return;
    }

    try {
      switch (operation.op) {
        case 'add':
          pointer.insert(current, operation.path, operation.value);
          break;
        case 'replace':
          // A replace requires the target to already exist.
          if (!pointer.has(current, operation.path)) {
            throw new Error(
              `cannot replace ${JSON.stringify(operation.path)}: path does not exist`
            );
          }
          pointer.set(current, operation.path, operation.value);
          break;
        case 'remove':
          // Let pointer.remove report the precise reason (missing key vs.
          // out-of-range index) instead of masking it with a generic check.
          pointer.remove(current, operation.path);
          break;
        default:
          // Unreachable: validateOperations rejects unknown ops.
          throw new Error(`operation ${index}: unhandled op ${JSON.stringify(operation.op)}`);
      }
    } catch (error) {
      // Re-throw with the operation index and path attached.
      const wrapped = new Error(`operation ${index} (${operation.op} ${operation.path}): ${error.message}`);
      wrapped.operationIndex = index;
      wrapped.operation = operation;
      throw wrapped;
    }
  });

  return current;
}

module.exports = { applyPatch, validateOperations };
