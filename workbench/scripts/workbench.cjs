#!/usr/bin/env node
'use strict';

// Development compatibility entry. Production behavior is maintained in the
// installable skill; only this repository entry supplies Vite/demo locations.
const path = require('node:path');
const runtime = require('../../skills/6ak-process-review/workbench/scripts/workbench.cjs');
const development = {
  developmentFrontend: path.resolve(__dirname, '..', 'frontend'),
  frozenDemoDirectory: path.resolve(__dirname, '..', '..', '.qa', 'workbench-fixtures', 'pricing-knowledge-base-20261113'),
};
const startServer = options => runtime.startServer({ ...options, developmentFrontend: development.developmentFrontend });
const main = args => runtime.main(args, development);
module.exports = { ...runtime, startServer, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
