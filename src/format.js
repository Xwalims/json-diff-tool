'use strict';

/**
 * Human-readable and machine rendering of diff operations.
 *
 * Output is deterministic: the same operation list always renders to exactly
 * the same bytes, which is what makes the text format usable in tests and
 * golden files.
 *
 * @module format
 */

/**
 * @typedef {import('./diff.js').DiffOperation} DiffOperation
 */

/**
 * @typedef {object} FormatOptions
 * @property {'pretty'|'compact'} [indent=2] Indentation of the JSON machine format.
 * @property {number} [maxValueLength=60] Values longer than this are truncated
 *   with an ellipsis in the text format. Use `0` to disable truncation.
 * @property {boolean} [showValues=true] Include the value column in the text format.
 */

const DEFAULT_FORMAT_OPTIONS = Object.freeze({
  indent: 2,
  maxValueLength: 60,
  showValues: true,
});

/**
 * Single-character markers used in the text format.
 *
 * @type {Record<string, string>}
 */
const MARKERS = Object.freeze({ add: '+', remove: '-', replace: '~' });

/**
 * Headers shown above each operation kind in the text format.
 *
 * @type {Record<string, string>}
 */
const LABELS = Object.freeze({ add: 'added', remove: 'removed', replace: 'changed' });

/**
 * Render a value compactly on one line, truncated for display.
 *
 * Strings are quoted so that an empty string and a string of spaces stay
 * visible, and so the output cannot be confused with a bare value.
 *
 * @param {*} value Value to render.
 * @param {number} maxLength Truncation limit; `0` disables truncation.
 * @returns {string} A single-line representation.
 */
function formatValue(value, maxLength) {
  let text;
  if (typeof value === 'string') {
    text = JSON.stringify(value);
  } else {
    text = JSON.stringify(value) ?? String(value);
  }
  if (maxLength > 0 && text.length > maxLength) {
    const keep = Math.max(1, maxLength - 3);
    return `${text.slice(0, keep)}...`;
  }
  return text;
}

/**
 * Group operations by kind while preserving their order inside each group.
 *
 * @param {DiffOperation[]} operations Operations to group.
 * @returns {Record<string, DiffOperation[]>} Operations keyed by `add`,
 *   `remove` and `replace`. Kinds with no operations are present but empty.
 */
function groupByOp(operations) {
  const groups = { add: [], remove: [], replace: [] };
  for (const operation of operations) {
    if (groups[operation.op]) groups[operation.op].push(operation);
  }
  return groups;
}

/**
 * Build the `path  old -> new` body for a single operation.
 *
 * @param {DiffOperation} operation Operation to render.
 * @param {Required<FormatOptions>} options Resolved options.
 * @returns {string} The aligned text body.
 */
function formatOperationBody(operation, options) {
  if (!options.showValues) return operation.path;

  const hasNew = 'value' in operation;
  const hasOld = 'oldValue' in operation;

  // With neither value present there is nothing to show after the path, so
  // emit the path alone rather than a dangling "->".
  if (!hasNew && !hasOld) return operation.path;

  if (operation.op === 'add') {
    return `${operation.path} = ${formatValue(operation.value, options.maxValueLength)}`;
  }
  if (operation.op === 'remove') {
    return hasOld ? `${operation.path} ${formatValue(operation.oldValue, options.maxValueLength)}` : operation.path;
  }
  if (!hasNew && hasOld) {
    return `${operation.path} ${formatValue(operation.oldValue, options.maxValueLength)}`;
  }
  if (hasNew && !hasOld) {
    return `${operation.path} -> ${formatValue(operation.value, options.maxValueLength)}`;
  }
  return `${operation.path} ${formatValue(operation.oldValue, options.maxValueLength)} -> ${formatValue(operation.value, options.maxValueLength)}`;
}

/**
 * Pad a string to a given display width, counting code points not UTF-16 units.
 *
 * @param {string} text Text to pad.
 * @param {number} width Target width.
 * @returns {string} The padded text.
 */
function padEnd(text, width) {
  const length = [...text].length;
  return length >= width ? text : text + ' '.repeat(width - length);
}

/**
 * Render operations as aligned, grouped text.
 *
 * Operations are grouped by kind in the fixed order add, replace, remove, and
 * the path column is padded so the values line up. A leading marker
 * (`+`, `~`, `-`) distinguishes the kinds at a glance.
 *
 * @param {DiffOperation[]} operations Operations to render.
 * @param {FormatOptions} [options] Format options.
 * @returns {string} The rendered text, ending with a newline when non-empty.
 * @throws {TypeError} If `operations` is not an array.
 *
 * @example
 * formatOps([{ op: 'replace', path: '/a', value: 2, oldValue: 1 }]);
 * // => '~ changed  /a  1 -> 2\n'
 */
function formatOps(operations, options = {}) {
  if (!Array.isArray(operations)) {
    throw new TypeError(
      `formatOps expects an array of operations, received ${operations === null ? 'null' : typeof operations}`
    );
  }
  const resolved = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  if (operations.length === 0) return '';

  const groups = groupByOp(operations);
  const order = ['add', 'replace', 'remove'];

  // The widest path across all operations sets the column width, so the
  // rendering stays aligned no matter which kinds are present.
  const widest = operations.reduce(
    (max, operation) => Math.max(max, [...operation.path].length),
    0
  );

  const lines = [];
  for (const op of order) {
    const group = groups[op];
    if (group.length === 0) continue;
    lines.push(`${LABELS[op]} (${group.length}):`);
    for (const operation of group) {
      const body = formatOperationBody(operation, resolved);
      // formatOperationBody starts with the raw path; split it off so the path
      // can be padded to a common width and the value column can line up.
      const rest = body.slice(operation.path.length).trimStart();
      let line;
      if (!resolved.showValues || rest === '') {
        line = `  ${MARKERS[op]} ${operation.path}`;
      } else {
        line = `  ${MARKERS[op]} ${padEnd(operation.path, widest)}  ${rest}`;
      }
      lines.push(line);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n$/, '\n');
}

/**
 * Render operations as a one-line-per-operation machine format.
 *
 * The output is the raw JSON array, which is what `--out` writes to disk and
 * what `applyPatch` accepts back.
 *
 * @param {DiffOperation[]} operations Operations to render.
 * @param {FormatOptions} [options] Format options; `indent` is honoured.
 * @returns {string} Serialised JSON, ending with a newline.
 * @throws {TypeError} If `operations` is not an array.
 */
function formatJson(operations, options = {}) {
  if (!Array.isArray(operations)) {
    throw new TypeError(
      `formatJson expects an array of operations, received ${operations === null ? 'null' : typeof operations}`
    );
  }
  const { indent = DEFAULT_FORMAT_OPTIONS.indent } = options;
  return `${JSON.stringify(operations, null, indent)}\n`;
}

/**
 * Render operations in either the text or the machine format.
 *
 * @param {DiffOperation[]} operations Operations to render.
 * @param {object} [options] Format options.
 * @param {boolean} [options.asJson=false] Emit the machine format.
 * @returns {string} The rendered output.
 */
function format(operations, options = {}) {
  return options.asJson ? formatJson(operations, options) : formatOps(operations, options);
}

/**
 * Render a one-line summary such as `3 operations: 1 added, 1 changed, 1 removed`.
 *
 * @param {DiffOperation[]} operations Operations to summarise.
 * @returns {string} The summary line.
 */
function formatSummary(operations) {
  const groups = groupByOp(operations);
  const parts = [
    `${groups.add.length} added`,
    `${groups.replace.length} changed`,
    `${groups.remove.length} removed`,
  ];
  return `${operations.length} ${operations.length === 1 ? 'operation' : 'operations'}: ${parts.join(', ')}`;
}

module.exports = { formatOps, formatJson, format, formatSummary, MARKERS, LABELS };
