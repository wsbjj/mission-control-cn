#!/usr/bin/env node
// Cross-platform start script: reads PORT from env (default 4000) and runs next start
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const port = String(process.env.PORT || 4000);
const cwd = path.join(__dirname, '..');
const nextBin = path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next');
const nextBinJs = nextBin + '.js';
const nextPath = fs.existsSync(nextBinJs) ? nextBinJs : nextBin;
const child = spawn(process.execPath, [nextPath, 'start', '-p', port], {
  stdio: 'inherit',
  cwd,
});
child.on('exit', (code) => process.exit(code ?? 0));
