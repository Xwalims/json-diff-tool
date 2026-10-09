'use strict';

/**
 * json-diff-tool / json-number.js
 *
 * Exact JSON number parsing and serialisation.
 *
 * THE BUG THIS FILE EXISTS TO FIX
 * ------------------------------
 * `JSON.parse` routes every number through an IEEE-754 double, so it cannot
 * represent an integer above 2^53-1:
 *
 *     JSON.parse('{"n":9007199254740993}').n === JSON.parse('{"n":9007199254740992}').n
 *     // true  -- two different documents, one value
 *
 * A diff tool that cannot tell two documents apart has failed at the only
 * thing it is for. `diff` returned zero operations and the CLI exited 0
 * ("the documents are equivalent"), on a document whose ID had silently
 * changed. Ground truth, Python's json module, which keeps integers exact:
 *
 *     json.loads('{"n":9007199254740993}') != json.loads('{"n":9007199254740992}')
 *     # True
 *
 * WHAT IS NOT CHANGED
 * -------------------
 * Numbers that fit in a double stay doubles. A document with no large integer
 * parses to exactly the same values it always did, `typeof` on every number
 * is unchanged, and `stringifyExact` is byte-for-byte identical to
 * `JSON.stringify` for it. This widens what the tool can see; it does not
 * change what it reports for ordinary documents.
 *
 * TWO INDEPENDENT PARSERS, ON PURPOSE
 * ----------------------------------
 * There is a fast path that reads the raw literal straight out of
 * `JSON.parse`'s reviver context, and a portable path that does not. The
 * portable one is not dead code kept for theory: it is the one that runs
 * whenever the runtime lacks the reviver context, which is a real possibility
 * on the Node 20 this package declares as its floor. Shipping only the fast
 * path would mean the fix silently disappears -- and the original bug returns
 * -- on exactly the oldest version in CI. `scripts/cross-check-numbers.py`
 * checks both against the same oracle, and the tests assert they agree.
 */

/** Does this runtime hand the reviver the raw source text of each value? */
const HAS_SOURCE_CONTEXT = (() => {
  try {
    let seen = false;
    JSON.parse('{"a":1}', (key, value, context) => {
      if (key === 'a' && context && typeof context.source === 'string') seen = true;
      return value;
    });
    return seen;
  } catch {
    return false;
  }
})();

/**
 * Parse JSON text, keeping integers outside the IEEE-754 safe range exact.
 *
 * Same accepted grammar and same SyntaxError behaviour as `JSON.parse`: this
 * delegates the grammar to it, and only ever replaces a value that a double
 * provably cannot hold. A malformed document throws exactly as before.
 *
 * @param {string} text JSON source text.
 * @returns {*} The parsed value; out-of-range integers are BigInt.
 * @throws {SyntaxError} If the text is not valid JSON, as `JSON.parse` does.
 */
function parseExact(text) {
  return HAS_SOURCE_CONTEXT ? parseWithContext(text) : parsePortable(text);
}

/**
 * Fast path: upgrade out-of-range integers using the reviver's raw literal.
 *
 * The decision is made on the RAW LITERAL, not on the parsed double. That
 * distinction is the whole fix: `context.source` is what the file actually
 * said, while the `value` argument is only what the double could hold.
 *
 * @param {string} text JSON source text.
 * @returns {*} The parsed value.
 */
function parseWithContext(text) {
  return JSON.parse(text, function reviveExactNumbers(key, value, context) {
    if (typeof value !== 'number') return value;
    const source = context && context.source;
    if (typeof source !== 'string') return value;
    // Only a plain integer literal can be recovered. A fraction or an exponent
    // means a real floating-point value, and inventing a BigInt would change
    // the document.
    if (!/^-?\d+$/.test(source)) return value;
    // Inside the safe range the double is already exact, so leave it alone and
    // keep `typeof` and arithmetic exactly as they were.
    if (Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
    try {
      return BigInt(source);
    } catch {
      // Unreachable for a `-?\d+` literal, but a throw here would turn a
      // document that parsed fine into a crash, so it never escapes.
      return value;
    }
  });
}

/** An integer literal, optionally negative. */
const INTEGER_RE = /^-?\d+$/;

/**
 * Locate every integer literal in the text that a double cannot represent.
 *
 * The scan is string-aware, so a number inside a string value is data and is
 * left alone -- `"9007199254740993"` is a perfectly good string, and turning
 * it into a BigInt would corrupt the document.
 *
 * @param {string} text JSON source text.
 * @returns {{literal: string, start: number, end: number}[]} Matches in
 *   document order.
 */
function findExactIntegers(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Skip over a string literal entirely, honouring backslash escapes.
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }

    // JSON has no other use for a digit or `-` outside a string.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (ch === '-') i += 1;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      const literal = text.slice(start, i);
      // Only a PURE integer counts. A fraction or an exponent means the double
      // holds a real floating-point value, which must be left alone.
      const continues = text[i] === '.' || text[i] === 'e' || text[i] === 'E';
      if (!continues && INTEGER_RE.test(literal)) {
        const asDouble = Number(literal);
        if (!Number.isFinite(asDouble) || Math.abs(asDouble) > Number.MAX_SAFE_INTEGER) {
          found.push({ literal, start, end: i });
        }
      }
      continue;
    }

    i += 1;
  }
  return found;
}

/**
 * Build a sentinel that cannot collide with the document's own data.
 *
 * The sentinel travels through the JSON as a string value, so it must not
 * occur in real data or a value would be replaced wrongly. A NUL cannot
 * appear RAW in JSON text, and a document can only contain one through the
 * `\u0000` escape -- which the JSON.stringify of the sentinel would also
 * produce, so the two could collide. The prefix therefore uses a character
 * that JSON forbids raw inside a string and that a plausible string value
 * will not contain, and the loop is kept as a belt-and-braces guard on top.
 *
 * The previous version embedded a raw NUL in the prefix and assumed the text
 * could not contain one. Both assumptions were wrong and the tests caught
 * them: a document with a literal NUL inside a string produced rewritten text
 * with a raw control character in a string, which is not valid JSON.
 *
 * @param {string} text JSON source text.
 * @returns {string} A prefix that occurs in no string value in the document.
 */
/**
 * Choose a sentinel prefix that no string value in the document can match.
 *
 * The sentinel rides through the rewrite as a string value, so it has to be
 * distinct from every string the document actually contains. The comparison
 * is against DECODED values, not against the source text, and that distinction
 * is the whole point -- two earlier versions got it wrong and the collision
 * probe is why:
 *
 *   1. A plain ASCII prefix like `EXACT0` is guessable. A document whose
 *      string value was exactly `EXACT0` had that string silently replaced by
 *      a BigInt: data corrupted to satisfy the parser.
 *   2. Delimiting with U+E000 fixed nothing, because the uniqueness check
 *      searched the raw SOURCE while the document wrote the character as the
 *      six-character escape `\ue000`. The search could never match, so the loop
 *      never ran and the same corruption happened.
 *
 * So the prefix is a NUL, which JSON forbids raw inside a string literal, and
 * the check walks the strings `JSON.parse` actually produced.
 *
 * @param {*} doc The parsed document.
 * @returns {string} A prefix that begins no string value in `doc`.
 */
function uniqueSentinelPrefix(doc) {
  const strings = new Set();
  collectStrings(doc, strings);
  let prefix = '\u0000';
  while ([...strings].some((value) => value.startsWith(prefix))) prefix += '\u0000';
  return prefix;
}

/**
 * Gather every string value reachable from a parsed document.
 *
 * @param {*} node Subtree to walk.
 * @param {Set<string>} out Accumulator.
 * @returns {void}
 */
function collectStrings(node, out) {
  if (typeof node === 'string') {
    out.add(node);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const key of Object.keys(node)) collectStrings(node[key], out);
  if (Array.isArray(node)) node.forEach((item) => collectStrings(item, out));
}

/**
 * Portable path: keep exact integers without any newer runtime feature.
 *
 * The trick is that a SENTINEL STRING cannot lose precision. Each
 * out-of-range literal is rewritten to a unique string before parsing, so the
 * digits survive `JSON.parse` untouched inside a type with all 53 bits and
 * more to spare; a tree walk afterwards puts a BigInt back.
 *
 * The sentinel rides along WITH the parse rather than being matched up to scan
 * positions afterwards, and that is deliberate. Object key order in JS is not
 * document order: integer-like keys sort first, so `{"b":1,"2":2}` has
 * `Object.keys` order `["2","b"]`. Any positional scheme walking keys in order
 * would attach the wrong value to the wrong key.
 *
 * @param {string} text JSON source text.
 * @returns {*} The parsed value.
 */
function parsePortable(text) {
  const found = findExactIntegers(text);
  if (found.length === 0) return JSON.parse(text);

  // Parse once, unmodified, to learn which strings the document really
  // contains. Those are what the sentinel has to avoid, and the check has to
  // see DECODED values: a document writing `\uE000` holds a one-character
  // U+E000, which no search over the source text could ever find. The
  // throwaway parse is the price of a collision-proof sentinel and it costs
  // nothing on the common path, which returns before reaching here.
  const probe = JSON.parse(text);
  const prefix = uniqueSentinelPrefix(probe);
  const sentinels = found.map((_match, index) => `${prefix}${index}`);

  let rewritten = '';
  let cursor = 0;
  for (let index = 0; index < found.length; index += 1) {
    rewritten += text.slice(cursor, found[index].start) + JSON.stringify(sentinels[index]);
    cursor = found[index].end;
  }
  rewritten += text.slice(cursor);

  const doc = JSON.parse(rewritten);
  const bySentinel = new Map();
  for (let index = 0; index < found.length; index += 1) {
    bySentinel.set(sentinels[index], found[index].literal);
  }

  // The document may BE a bare integer, e.g. the file contains `9007199254740993`
  // rather than an object. That parses to a sentinel STRING at the root, and
  // restoreExactNumbers only walks containers, so the root is handled here.
  // Without this, a top-level big integer silently came back as the sentinel
  // string -- a document turned into a string, which is worse than the
  // original rounding bug.
  if (typeof doc === 'string' && bySentinel.has(doc)) return BigInt(bySentinel.get(doc));

  restoreExactNumbers(doc, bySentinel);
  return doc;
}

/**
 * Replace sentinel strings with the BigInt they stand for, in place.
 *
 * Assignment is safe on a `JSON.parse` result: every key in it is an own DATA
 * property, including one literally named `__proto__`, which therefore
 * shadows the inherited accessor rather than triggering it.
 *
 * @param {*} node Subtree to walk.
 * @param {Map<string,string>} bySentinel Sentinel to its exact literal.
 * @returns {void}
 */
function restoreExactNumbers(node, bySentinel) {
  if (node === null || typeof node !== 'object') return;
  const keys = Array.isArray(node) ? null : Object.keys(node);
  const items = keys === null ? node : keys.map((key) => node[key]);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item === 'string') {
      const literal = bySentinel.get(item);
      if (literal !== undefined) {
        if (keys === null) node[index] = BigInt(literal);
        else node[keys[index]] = BigInt(literal);
      }
    } else {
      restoreExactNumbers(item, bySentinel);
    }
  }
}

/**
 * Parse JSON text keeping exact integers without depending on the reviver
 * context. Slower, and identical in result.
 *
 * @param {string} text JSON source text.
 * @returns {*} The parsed value; out-of-range integers are BigInt.
 */
function parseExactPortable(text) {
  return parsePortable(text);
}

/**
 * Serialise a value to JSON text, writing an exact integer as a bare literal.
 *
 * WHY THIS IS NOT A REPLACER
 * --------------------------
 * The obvious fix is a replacer that turns a BigInt into a string, and it is
 * wrong in a way that is easy to miss:
 *
 *     JSON.stringify({ n: 10n }, (k, v) => typeof v === 'bigint' ? String(v) : v)
 *     // => '{"n":"10"}'   -- a QUOTED STRING, not the number 10
 *
 * A replacer returns a VALUE, and a string value is serialised as a string.
 * There is no way to inject a raw token through it. `JSON.rawJSON` can, but
 * it is Node 22+ and this package supports Node 20, and it does not survive
 * `structuredClone` -- which every deep-copy path here uses. So the emitter is
 * written out, and the fast path keeps the builtin:
 *
 *     if (!containsBigInt(value)) return JSON.stringify(value, null, indent);
 *
 * That line is what guarantees the no-regression half of the contract. A
 * document with no exact integer goes through the exact same builtin call the
 * tool made before, so its output cannot drift.
 *
 * @param {*} value Value to serialise.
 * @param {number|string} [indent] Passed through to `JSON.stringify`.
 * @returns {string} JSON text.
 */
function stringifyExact(value, indent) {
  if (!containsBigInt(value)) return JSON.stringify(value, null, indent);
  return write(value, normalizeIndent(indent), '');
}

/**
 * Does this value contain a BigInt anywhere?
 *
 * A structural scan, so the common case costs one walk and then nothing: no
 * BigInt means the builtin serialiser and its exact escaping rules apply.
 *
 * @param {*} value Value to scan.
 * @returns {boolean} `true` when a BigInt is reachable.
 */
function containsBigInt(value) {
  if (typeof value === 'bigint') return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsBigInt);
  return Object.keys(value).some((key) => containsBigInt(value[key]));
}

/**
 * Reduce `JSON.stringify`'s space argument to the forms it accepts.
 *
 * `JSON.stringify` clamps a numeric gap to 10 and ignores anything past the
 * first character of a string gap. The builtin is still consulted on the fast
 * path; this only has to keep the two paths from disagreeing.
 *
 * @param {number|string|undefined} gap Indent argument.
 * @returns {number|string} The gap as a number.
 */
function normalizeIndent(gap) {
  if (gap === undefined || gap === null) return 0;
  const n = Number(gap);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10, Math.floor(n));
}

/**
 * Emit one value as JSON, handling indentation and BigInt literals by hand.
 *
 * String escaping is delegated to `JSON.stringify` rather than reimplemented.
 * Escaping rules are the one part of this that must be exactly right for
 * surrogate pairs, control characters and lone surrogates, and the builtin is
 * the reference implementation of them by definition. The only things done by
 * hand here are structure, indentation and the BigInt literal.
 *
 * @param {*} value Value to emit.
 * @param {number} gap Indent width for this level.
 * @param {string} prefix Whitespace already written on the current line.
 * @returns {string} JSON text for the value.
 */
function write(value, gap, prefix) {
  if (typeof value === 'bigint') return value.toString();
  if (value === null) return 'null';

  const kind = typeof value;
  if (kind === 'number') {
    // NaN and Infinity are not JSON; the builtin maps them to null and so
    // does this. A document that came from `parseExact` cannot contain either.
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const body = value.map((item, index) => {
      // A hole or undefined becomes null in an array, exactly as the builtin
      // does -- it does not shorten the array.
      if (item === undefined) return gap === 0 ? 'null' : `${prefix}  null`;
      const text = containsBigInt(item) ? write(item, gap, `${prefix}  `) : JSON.stringify(item) ?? 'null';
      return gap === 0 ? text : `${prefix}  ${text}`;
    });
    if (gap === 0) return `[${body.join(',')}]`;
    return `[\n${body.join(',\n')}\n${prefix}]`;
  }

  // An object with a `toJSON` is not plain JSON data; defer so Dates and the
  // like keep behaving as they always did.
  if (typeof value.toJSON === 'function') return write(value.toJSON(), gap, prefix);

  const pairs = [];
  for (const key of Object.keys(value)) {
    const item = value[key];
    // Undefined-valued keys are omitted, as JSON.stringify omits them.
    if (item === undefined) continue;
    const name = JSON.stringify(key);
    const raw = containsBigInt(item) ? write(item, gap, `${prefix}  `) : JSON.stringify(item) ?? 'null';
    pairs.push(gap === 0 ? `${name}:${raw}` : `${prefix}  ${name}: ${raw}`);
  }
  if (pairs.length === 0) return '{}';
  if (gap === 0) return `{${pairs.join(',')}}`;
  return `{\n${pairs.join(',\n')}\n${prefix}}`;
}

module.exports = {
  parseExact,
  parseExactPortable,
  stringifyExact,
  HAS_SOURCE_CONTEXT,
};