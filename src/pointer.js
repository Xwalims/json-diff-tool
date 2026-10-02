'use strict';

/**
 * JSON Pointer (RFC 6901) helpers.
 *
 * A pointer is either the empty string (the whole document) or a sequence of
 * `/`-prefixed reference tokens. `~` and `/` inside a token are escaped as
 * `~0` and `~1`.
 *
 * @module pointer
 */

/** Sentinel used to distinguish "no value" from a legitimate `undefined`. */
const MISSING = Symbol('pointer.missing');

const ARRAY_INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

/**
 * Escape a single reference token for use inside a JSON Pointer.
 *
 * `~` becomes `~0` and `/` becomes `~1`. The order matters: escaping `~`
 * first guarantees that a literal `~1` in a key round-trips back to `~1`
 * rather than being decoded as `/`.
 *
 * @param {string|number} token Raw object key or array index.
 * @returns {string} The escaped token.
 */
function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Reverse {@link escapeToken}.
 *
 * `~1` is decoded first so that the two-character sequence `~01` decodes to
 * the literal `~1` instead of to `/`.
 *
 * @param {string} token Escaped reference token.
 * @returns {string} The raw token.
 */
function unescapeToken(token) {
  return String(token).replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Build a JSON Pointer string from a list of reference tokens.
 *
 * @param {Array<string|number>} tokens Reference tokens, outermost first.
 * @returns {string} The encoded pointer; `''` for an empty token list.
 * @throws {TypeError} If `tokens` is not an array.
 */
function encodePointer(tokens) {
  const list = Array.isArray(tokens) ? tokens : [tokens];
  if (list.length === 0) return '';
  return list.map((token) => `/${escapeToken(token)}`).join('');
}

/**
 * Parse a JSON Pointer string into its reference tokens.
 *
 * @param {string} pointer A JSON Pointer, `''` or a string starting with `/`.
 * @returns {string[]} The decoded tokens; an empty array for `''`.
 * @throws {TypeError} If `pointer` is not a string.
 * @throws {SyntaxError} If the pointer is malformed or contains an invalid
 *   escape sequence (RFC 6901 does not permit a bare `~` in a token).
 */
function decodePointer(pointer) {
  if (typeof pointer !== 'string') {
    throw new TypeError(`JSON Pointer must be a string, received ${typeof pointer}`);
  }
  if (pointer === '') return [];
  if (pointer.charAt(0) !== '/') {
    throw new SyntaxError(`Invalid JSON Pointer ${JSON.stringify(pointer)}: must be "" or start with "/"`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((raw, index) => {
      if (/~(?![01])/.test(raw)) {
        throw new SyntaxError(
          `Invalid JSON Pointer ${JSON.stringify(pointer)}: token #${index} contains the illegal escape ${JSON.stringify(raw)}`
        );
      }
      return unescapeToken(raw);
    });
}

/**
 * Classify a value so that containers can be distinguished from leaves.
 *
 * @param {*} value Any value.
 * @returns {string} One of `array`, `object`, `null`, `string`, `number`,
 *   `boolean`, `undefined`.
 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Convert a reference token to an array index.
 *
 * @param {string|number} token Reference token.
 * @returns {number|null} The index, or `null` when the token is not a
 *   non-negative integer without leading zeros.
 */
function toArrayIndex(token) {
  const text = String(token);
  if (!ARRAY_INDEX_RE.test(text)) return null;
  const index = Number(text);
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * Read the value addressed by a pointer.
 *
 * @param {*} doc Document to read from.
 * @param {string} pointer JSON Pointer.
 * @param {*} [fallback] Returned when the pointer does not resolve.
 * @returns {*} The addressed value or `fallback`.
 */
function get(doc, pointer, fallback) {
  const tokens = decodePointer(pointer);
  let current = doc;
  for (const token of tokens) {
    if (typeOf(current) !== 'object' && typeOf(current) !== 'array') return fallback;
    if (Array.isArray(current)) {
      const index = toArrayIndex(token);
      if (index === null || index >= current.length) return fallback;
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return fallback;
      current = current[token];
    }
  }
  return current;
}

/**
 * Test whether a pointer addresses an existing location.
 *
 * @param {*} doc Document to probe.
 * @param {string} pointer JSON Pointer.
 * @returns {boolean} `true` when {@link get} would return an own value.
 */
function has(doc, pointer) {
  return get(doc, pointer, MISSING) !== MISSING;
}

/**
 * Resolve the container that owns the last token of a pointer.
 *
 * @param {*} doc Document to walk.
 * @param {string} pointer JSON Pointer.
 * @param {number} [index] Operation index, used only in error messages.
 * @returns {{parent: *, token: string|number|null, tokens: string[]}} The
 *   parent container, the final token and the full token list.
 * @throws {SyntaxError} If the pointer is malformed.
 * @throws {Error} If the pointer addresses the whole document or if a parent
 *   segment is missing or is not a container.
 */
function resolveParent(doc, pointer, index = 0) {
  const tokens = decodePointer(pointer);
  if (tokens.length === 0) {
    throw new SyntaxError(
      `operation ${index}: the empty pointer addresses the whole document, not a parent`
    );
  }
  const parents = tokens.slice(0, -1);
  let current = doc;
  parents.forEach((token, depth) => {
    const kind = typeOf(current);
    if (kind !== 'object' && kind !== 'array') {
      throw new Error(
        `operation ${index}: cannot reach ${JSON.stringify(pointer)} because ` +
          `${JSON.stringify(encodePointer(tokens.slice(0, depth + 1)))} is ${kind}, not a container`
      );
    }
    if (Array.isArray(current)) {
      const arrayIndex = toArrayIndex(token);
      if (arrayIndex === null || arrayIndex >= current.length) {
        throw new Error(
          `operation ${index}: cannot reach ${JSON.stringify(pointer)} because array index ` +
            `${JSON.stringify(token)} is out of range (length ${current.length})`
        );
      }
      current = current[arrayIndex];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new Error(
          `operation ${index}: cannot reach ${JSON.stringify(pointer)} because ` +
            `${JSON.stringify(encodePointer(tokens.slice(0, depth + 1)))} does not exist`
        );
      }
      current = current[token];
    }
  });

  const token = tokens[tokens.length - 1];
  return { parent: current, token, tokens };
}

/**
 * Write a value at a pointer, mutating the document in place.
 *
 * When the parent is an array, a numeric token inserts at that position
 * (shifting later elements right) and the token `-` appends, matching
 * RFC 6902 `add` semantics.
 *
 * @param {*} doc Document to mutate.
 * @param {string} pointer JSON Pointer.
 * @param {*} value Value to store (deep-copied before insertion).
 * @returns {*} The document root after the assignment. This is `doc` itself
 *   unless `pointer` was `''`, in which case the assigned value is returned.
 * @throws {SyntaxError} If the pointer is malformed.
 * @throws {Error} If a parent segment is missing or an array index is out of range.
 */
function set(doc, pointer, value) {
  const tokens = decodePointer(pointer);
  if (tokens.length === 0) return clone(value);

  const { parent, token } = resolveParent(doc, pointer);
  const kind = typeOf(parent);
  if (kind !== 'object' && kind !== 'array') {
    throw new Error(
      `cannot set ${JSON.stringify(pointer)}: parent is ${kind}, not a container`
    );
  }
  if (Array.isArray(parent)) {
    if (token === '-') {
      parent.push(clone(value));
      return doc;
    }
    const index = toArrayIndex(token);
    if (index === null || index > parent.length) {
      throw new Error(
        `cannot set ${JSON.stringify(pointer)}: array index ${JSON.stringify(token)} ` +
          `is out of range (length ${parent.length})`
      );
    }
    if (index === parent.length) {
      parent.push(clone(value));
      return doc;
    }
    parent.splice(index, 0, clone(value));
    return doc;
  }
  parent[token] = clone(value);
  return doc;
}

/**
 * Delete the value addressed by a pointer, mutating the document in place.
 *
 * @param {*} doc Document to mutate.
 * @param {string} pointer JSON Pointer.
 * @returns {*} The document root (`doc`; the root itself cannot be removed).
 * @throws {SyntaxError} If the pointer is malformed or is `''`.
 * @throws {Error} If the target is missing or an array index is out of range.
 */
function remove(doc, pointer) {
  const tokens = decodePointer(pointer);
  if (tokens.length === 0) {
    throw new SyntaxError('cannot remove the whole document with a pointer');
  }
  const { parent, token } = resolveParent(doc, pointer);
  const kind = typeOf(parent);
  if (kind !== 'object' && kind !== 'array') {
    throw new Error(
      `cannot remove ${JSON.stringify(pointer)}: parent is ${kind}, not a container`
    );
  }
  if (Array.isArray(parent)) {
    const index = toArrayIndex(token);
    if (index === null || index >= parent.length) {
      throw new Error(
        `cannot remove ${JSON.stringify(pointer)}: array index ${JSON.stringify(token)} ` +
          `is out of range (length ${parent.length})`
      );
    }
    parent.splice(index, 1);
    return doc;
  }
  if (!Object.prototype.hasOwnProperty.call(parent, token)) {
    throw new Error(`cannot remove ${JSON.stringify(pointer)}: key does not exist`);
  }
  delete parent[token];
  return doc;
}

/**
 * Deep-copy a JSON-compatible value.
 *
 * @param {*} value Value to copy.
 * @returns {*} An independent copy.
 */
function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

module.exports = {
  escapeToken,
  unescapeToken,
  encodePointer,
  decodePointer,
  typeOf,
  toArrayIndex,
  get,
  has,
  set,
  remove,
  resolveParent,
  clone,
};
