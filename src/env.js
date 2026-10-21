'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Loads .env from the project root if present. Variables already set in the
// environment (e.g. by the hosting panel) take precedence.
function loadEnvFile(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
    return;
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}

module.exports = { loadEnvFile };
