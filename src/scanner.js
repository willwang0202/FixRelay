const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function semgrepAvailable(_spawn = cp.spawnSync) {
  const result = _spawn('semgrep', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0;
}

function runSemgrep({ cwd = process.cwd(), config = 'auto', outDir, _spawn = cp.spawnSync } = {}) {
  const sarifPath = outDir
    ? path.join(outDir, 'semgrep.sarif')
    : path.join(os.tmpdir(), `fixrelay-semgrep-${Date.now()}.sarif`);

  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  const args = ['scan', '--config', config, '--sarif', '--output', sarifPath, '--no-git-ignore'];
  const result = _spawn('semgrep', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Semgrep exits 1 when findings are present — that is a normal success case.
  // Exit 2+ indicates a configuration or authentication error.
  if (result.status !== null && result.status >= 2) {
    return {
      ok: false,
      error: `semgrep exited with code ${result.status}`,
      stderr: String(result.stderr || '').trim()
    };
  }

  if (!fs.existsSync(sarifPath)) {
    return { ok: false, error: 'semgrep did not produce a SARIF file', stderr: String(result.stderr || '').trim() };
  }

  return { ok: true, sarifPath };
}

module.exports = { runSemgrep, semgrepAvailable };
