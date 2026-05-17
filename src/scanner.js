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

/**
 * Run Semgrep on a specific list of files rather than the whole repo.
 * Used by the pre-commit hook to scan only staged files.
 *
 * If `files` is empty, returns { ok: true, sarifPath: null, skipped: true }
 * without invoking Semgrep (to avoid accidentally scanning the whole repo).
 *
 * @param {{ cwd?, files, config?, outDir?, _spawn? }} opts
 */
function runSemgrepOnFiles({ cwd = process.cwd(), files = [], config = 'auto', outDir, _spawn = cp.spawnSync } = {}) {
  if (files.length === 0) {
    return { ok: true, sarifPath: null, skipped: true };
  }

  const sarifPath = outDir
    ? path.join(outDir, 'semgrep-staged.sarif')
    : path.join(os.tmpdir(), `fixrelay-semgrep-staged-${Date.now()}.sarif`);

  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  const args = ['scan', '--config', config, '--sarif', '--output', sarifPath, ...files];
  const result = _spawn('semgrep', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

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

module.exports = { runSemgrep, runSemgrepOnFiles, semgrepAvailable };
