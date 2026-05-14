const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runSemgrep, semgrepAvailable } = require('../src/scanner.js');
const { runFixRelay } = require('../src/runner.js');

// --- semgrepAvailable ---

test('semgrepAvailable returns true when semgrep --version exits 0', () => {
  const fakeSpawn = () => ({ status: 0, stdout: 'semgrep 1.0.0', stderr: '' });
  assert.equal(semgrepAvailable(fakeSpawn), true);
});

test('semgrepAvailable returns false when semgrep --version exits non-zero', () => {
  const fakeSpawn = () => ({ status: 1, stdout: '', stderr: '' });
  assert.equal(semgrepAvailable(fakeSpawn), false);
});

test('semgrepAvailable returns false when spawn errors (not on PATH)', () => {
  const fakeSpawn = () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' });
  assert.equal(semgrepAvailable(fakeSpawn), false);
});

// --- runSemgrep ---

function makeSarif(findings = 0) {
  const results = Array.from({ length: findings }, (_, i) => ({
    ruleId: `rule.${i}`,
    level: 'warning',
    message: { text: `Finding ${i}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: `file${i}.js` }, region: { startLine: i + 1 } } }]
  }));
  return JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Semgrep', rules: results.map((r, i) => ({ id: `rule.${i}`, shortDescription: { text: `Finding ${i}` } })) } },
      results
    }]
  });
}

test('runSemgrep returns ok:true and sarifPath when semgrep exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scanner-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = (_cmd, _args, _opts) => {
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = _args[_args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(1));
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runSemgrep({ cwd: tmp, outDir, _spawn: fakeSpawn });
  assert.equal(result.ok, true);
  assert.ok(result.sarifPath.endsWith('semgrep.sarif'));
  assert.ok(fs.existsSync(result.sarifPath));
});

test('runSemgrep treats exit 1 (findings present) as ok', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scanner-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = (_cmd, _args) => {
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = _args[_args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(2));
    return { status: 1, stdout: '', stderr: '' };
  };

  const result = runSemgrep({ cwd: tmp, outDir, _spawn: fakeSpawn });
  assert.equal(result.ok, true);
});

test('runSemgrep returns ok:false when semgrep exits 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scanner-'));
  const fakeSpawn = () => ({ status: 2, stdout: '', stderr: 'config error' });
  const result = runSemgrep({ cwd: tmp, _spawn: fakeSpawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited with code 2/);
});

test('runSemgrep returns ok:false when SARIF file is not written', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scanner-'));
  const fakeSpawn = () => ({ status: 0, stdout: '', stderr: '' });
  const result = runSemgrep({ cwd: tmp, _spawn: fakeSpawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not produce a SARIF file/);
});

test('runSemgrep passes --config value to semgrep', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scanner-'));
  const outDir = path.join(tmp, 'out');
  let capturedArgs;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = args[args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(0));
    return { status: 0, stdout: '', stderr: '' };
  };

  runSemgrep({ cwd: tmp, outDir, config: 'p/owasp-top-ten', _spawn: fakeSpawn });
  assert.ok(capturedArgs.includes('p/owasp-top-ten'));
});

// --- runFixRelay auto-scan integration ---

test('runFixRelay auto-runs Semgrep when no sarif or scanner-json provided', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-autoscan-'));
  const outDir = path.join(tmp, 'out');
  let semgrepWasCalled = false;

  const fakeSpawn = (cmd, args, _opts) => {
    if (args && args[0] === '--version') return { status: 0, stdout: 'semgrep 1.0.0', stderr: '' };
    semgrepWasCalled = true;
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = args[args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(0));
    return { status: 0, stdout: '', stderr: '' };
  };

  await runFixRelay({ sarifPaths: [], scannerJsonPaths: [], outDir, failOn: 'never', _spawn: fakeSpawn });
  assert.equal(semgrepWasCalled, true);
});

test('runFixRelay skips auto-scan when runSemgrep:false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-noscanner-'));
  const outDir = path.join(tmp, 'out');
  let spawnCalled = false;

  const fakeSpawn = () => { spawnCalled = true; return { status: 0 }; };

  await runFixRelay({ sarifPaths: [], scannerJsonPaths: [], outDir, failOn: 'never', runSemgrep: false, _spawn: fakeSpawn });
  assert.equal(spawnCalled, false);
});

test('runFixRelay skips auto-scan when sarif paths are provided', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-explicit-sarif-'));
  const sarifPath = path.join(tmp, 'scan.sarif');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(sarifPath, makeSarif(0));
  let spawnCalled = false;

  const fakeSpawn = () => { spawnCalled = true; return { status: 0 }; };

  await runFixRelay({ sarifPaths: [sarifPath], scannerJsonPaths: [], outDir, failOn: 'never', _spawn: fakeSpawn });
  assert.equal(spawnCalled, false);
});

test('runFixRelay continues gracefully when Semgrep is not on PATH', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-no-semgrep-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' });

  const summary = await runFixRelay({ sarifPaths: [], scannerJsonPaths: [], outDir, failOn: 'never', _spawn: fakeSpawn });
  assert.equal(summary.findingCount, 0);
  assert.ok(fs.existsSync(summary.artifacts.report));
});

test('runFixRelay continues gracefully when Semgrep scan fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scan-fail-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = (cmd, args) => {
    if (args && args[0] === '--version') return { status: 0, stdout: 'semgrep 1.0.0', stderr: '' };
    return { status: 3, stdout: '', stderr: 'fatal error' };
  };

  const summary = await runFixRelay({ sarifPaths: [], scannerJsonPaths: [], outDir, failOn: 'never', _spawn: fakeSpawn });
  assert.equal(summary.findingCount, 0);
  assert.ok(fs.existsSync(summary.artifacts.report));
});
