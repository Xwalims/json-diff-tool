'use strict';

/**
 * Public library entry point.
 *
 * @module json-diff-tool
 */

const pointer = require('./pointer.js');
const diffModule = require('./diff.js');
const apply = require('./apply.js');
const mergeModule = require('./merge.js');
const format = require('./format.js');
const jsonNumber = require('./json-number.js');

module.exports = {
  diff: diffModule.diff,
  deepEqual: diffModule.deepEqual,
  summarize: diffModule.summarize,
  applyPatch: apply.applyPatch,
  validateOperations: apply.validateOperations,
  merge: mergeModule.merge,
  formatOps: format.formatOps,
  formatJson: format.formatJson,
  formatSummary: format.formatSummary,
  format: format.format,
  // Exact-number pair. Use `parseExact` to read a document without losing an
  // integer above 2^53, and `stringifyExact` to write one back out -- plain
  // JSON.parse and JSON.stringify respectively lose the value and throw on it.
  parseExact: jsonNumber.parseExact,
  stringifyExact: jsonNumber.stringifyExact,
  pointer,
};
