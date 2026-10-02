#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli.js');

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`json-diff: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 2;
  });
