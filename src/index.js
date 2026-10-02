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
  pointer,
};
