'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { diff } = require('./diff.js');
const { applyPatch } = require('./apply.js');
const { merge } = require('./merge.js');
const { formatOps, formatJson, formatSummary } = require('./format.js');

/**
 * Command line interface for json-diff.
 *
 * argv is parsed by hand so the tool stays dependency free.
 *
 * Exit codes: 0 no differences, 1 differences found, 2 usage, IO or parse
 * error.
 *
 * @module cli
 */

/** @type {0|1|2} */
const EXIT = Object.freeze({ SAME: 0, DIFFERENT: 1, ERROR: 2 });

const USAGE = `Usage: json-diff <A.json> <B.json> [options]

Compare two JSON documents and print the operations that turn A into B.
Pass "-" as either path to read that document from stdin.

Options:
  --array-mode <index|lcs>  How to compare arrays (default: index).
                            index pairs elements by position.
                            lcs    matches shared elements so an
                                   inserted item costs one operation.
  --json                    Emit the machine-readable JSON array.
  --no-values               Hide values, print paths only.
  --quiet                   Print nothing; rely on the exit code.
  --out <PATCH.json>        Write the JSON operation array to a file.
  --merge                   Instead of diffing, deep-merge B onto A and
                            print the merged document.
  --merge-array <policy>    Arrays during --merge: replace (default),
                            concat or union.
  --merge-null <policy>     Nulls during --merge: overwrite (default),
                            ignore or keep.
  -h, --help                Show this help.
  -v, --version             Show the version.

Exit codes:
  0  the documents are equivalent
  1  differences were found
  2  usage, IO or parse error`;

/**
 * A CLI failure that should be reported as a message rather than a stack.
 */
class UsageError extends Error {}

/**
 * Read a whole stream as UTF-8.
 *
 * @param {NodeJS.ReadableStream} stream Stream to consume.
 * @returns {Promise<string>} The stream contents.
 */
function readStream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

/**
 * Load and parse a JSON document from a file path or from stdin.
 *
 * @param {string} source Path to a file, or `-` for stdin.
 * @param {string} label Human-readable name used in error messages.
 * @param {NodeJS.ReadableStream} [stdin] Stream used when source is `-`.
 * @returns {Promise<*>} The parsed document.
 * @throws {UsageError} If the file is missing, unreadable or not valid JSON.
 */
async function loadDocument(source, label, stdin = process.stdin) {
  let text;
  if (source === '-') {
    text = await readStream(stdin);
  } else {
    try {
      text = fs.readFileSync(source, 'utf8');
    } catch (error) {
      throw new UsageError(`cannot read ${label} ${JSON.stringify(source)}: ${error.message}`);
    }
  }

  if (text.trim() === '') {
    throw new UsageError(`${label} ${JSON.stringify(source)} is empty`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} ${JSON.stringify(source)} is not valid JSON: ${error.message}`);
  }
}

/**
 * Parse argv into a normalised options object.
 *
 * @param {string[]} argv Arguments after the node binary and script path.
 * @returns {{help: boolean, version: boolean, quiet: boolean, asJson: boolean,
 *   showValues: boolean, arrayMode: string, out: string|null, merge: boolean,
 *   mergeArray: string, mergeNull: string, sources: string[]}} Parsed options.
 * @throws {UsageError} On an unknown flag, a missing value or bad arity.
 */
function parseArgs(argv) {
  const options = {
    help: false,
    version: false,
    quiet: false,
    asJson: false,
    showValues: true,
    arrayMode: 'index',
    out: null,
    merge: false,
    mergeArray: 'replace',
    mergeNull: 'overwrite',
    sources: [],
  };

  /**
   * Read the value that must follow a flag.
   *
   * @param {string} flag Flag name, for the error message.
   * @param {string[]} args Full argument list.
   * @param {number} index Index of the flag.
   * @returns {string} The flag value.
   * @throws {UsageError} If the flag has no value.
   */
  function takeValue(flag, args, index) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--json':
        options.asJson = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--no-values':
        options.showValues = false;
        break;
      case '--merge':
        options.merge = true;
        break;
      case '--array-mode': {
        const value = takeValue('--array-mode', argv, i);
        if (value !== 'index' && value !== 'lcs') {
          throw new UsageError(`--array-mode must be "index" or "lcs", received ${JSON.stringify(value)}`);
        }
        options.arrayMode = value;
        i += 1;
        break;
      }
      case '--merge-array': {
        const value = takeValue('--merge-array', argv, i);
        if (!['replace', 'concat', 'union'].includes(value)) {
          throw new UsageError(
            `--merge-array must be "replace", "concat" or "union", received ${JSON.stringify(value)}`
          );
        }
        options.mergeArray = value;
        i += 1;
        break;
      }
      case '--merge-null': {
        const value = takeValue('--merge-null', argv, i);
        if (!['overwrite', 'ignore', 'keep'].includes(value)) {
          throw new UsageError(
            `--merge-null must be "overwrite", "ignore" or "keep", received ${JSON.stringify(value)}`
          );
        }
        options.mergeNull = value;
        i += 1;
        break;
      }
      case '--out':
        options.out = takeValue('--out', argv, i);
        i += 1;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new UsageError(`unknown option ${JSON.stringify(arg)}`);
        }
        options.sources.push(arg);
    }
  }

  return options;
}

/**
 * Write text to a file, reporting failures as usage errors.
 *
 * @param {string} target Destination path.
 * @param {string} contents Data to write.
 * @throws {UsageError} If the file cannot be written.
 */
function writeFileOrFail(target, contents) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, contents);
  } catch (error) {
    throw new UsageError(`cannot write ${JSON.stringify(target)}: ${error.message}`);
  }
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv Arguments after the node binary and script path.
 * @param {object} [io] Injectable IO, used by the tests.
 * @param {string} [io.stdout] Stream for normal output.
 * @param {string} [io.stderr] Stream for error output.
 * @param {NodeJS.ReadableStream} [io.stdin] Stream read when a path is `-`.
 * @returns {Promise<number>} The process exit code.
 */
async function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`json-diff: ${error.message}\n`);
    stderr.write(`\n${USAGE}\n`);
    return EXIT.ERROR;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.SAME;
  }

  if (options.version) {
    // package.json sits one level above src/ when running from the repo.
    const pkg = require('../package.json');
    stdout.write(`${pkg.name} ${pkg.version}\n`);
    return EXIT.SAME;
  }

  if (options.sources.length !== 2) {
    stderr.write(
      `json-diff: expected exactly 2 documents, received ${options.sources.length}\n\n${USAGE}\n`
    );
    return EXIT.ERROR;
  }

  let a;
  let b;
  try {
    a = await loadDocument(options.sources[0], 'document A', stdin);
    b = await loadDocument(options.sources[1], 'document B', stdin);
  } catch (error) {
    stderr.write(`json-diff: ${error.message}\n`);
    return EXIT.ERROR;
  }

  if (options.merge) {
    // Validate the policies before merging so bad input fails loudly.
    try {
      const merged = merge(a, b, { arrayPolicy: options.mergeArray, nullPolicy: options.mergeNull });
      const text = `${JSON.stringify(merged, null, 2)}\n`;
      if (options.out) writeFileOrFail(options.out, text);
      if (!options.quiet) stdout.write(text);
      return EXIT.SAME;
    } catch (error) {
      stderr.write(`json-diff: ${error.message}\n`);
      return EXIT.ERROR;
    }
  }

  let operations;
  try {
    operations = diff(a, b, { arrayMode: options.arrayMode });
  } catch (error) {
    stderr.write(`json-diff: ${error.message}\n`);
    return EXIT.ERROR;
  }

  if (options.out) {
    writeFileOrFail(options.out, formatJson(operations));
  }

  if (options.quiet) {
    return operations.length === 0 ? EXIT.SAME : EXIT.DIFFERENT;
  }

  if (operations.length === 0) {
    // The machine format must stay parseable even when there is nothing to
    // report, so it emits an empty array rather than a human-readable line.
    if (options.asJson) {
      stdout.write(formatJson(operations));
    } else {
      stdout.write('no differences\n');
    }
    return EXIT.SAME;
  }

  if (options.asJson) {
    stdout.write(formatJson(operations));
  } else {
    stdout.write(formatOps(operations, { showValues: options.showValues }));
    // A blank line keeps the summary visually separate from the last group.
    stdout.write(`\n${formatSummary(operations)}\n`);
  }
  return EXIT.DIFFERENT;
}

/**
 * Re-exported so `applyPatch` users can validate a patch file before applying it.
 */
module.exports = { run, parseArgs, loadDocument, EXIT, USAGE, UsageError, applyPatch };
