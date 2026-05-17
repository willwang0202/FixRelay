const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runSemgrep, runSemgrepOnFiles, semgrepAvailable } = require('../src/scanner.js');
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

test('runFixRelay sets risk unknown when Semgrep is not on PATH', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-no-semgrep-warn-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' });

  const summary = await runFixRelay({ sarifPaths: [], scannerJsonPaths: [], outDir, failOn: 'never', _spawn: fakeSpawn });
  assert.equal(summary.risk.level, 'unknown');
  assert.equal(summary.risk.decision, 'warn');
  assert.ok(typeof summary.scannerWarning === 'string');
  assert.match(summary.scannerWarning, /Semgrep is not installed/);
  const report = fs.readFileSync(summary.artifacts.report, 'utf8');
  assert.match(report, /Merge Risk: Unknown/);
  assert.match(report, /Risk could not be assessed/);
});

test('runFixRelay sets risk unknown when Semgrep scan fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-scan-fail-warn-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = (cmd, args) => {
    if (args && args[0] === '--version') return { status: 0, stdout: 'semgrep 1.0.0', stderr: '' };
    return { status: 3, stdout: '', stderr: 'fatal error' };
  };

  const summary = await runFixRelay({ sarifPaths: [], scannerJsonPaths: [], outDir, failOn: 'never', _spawn: fakeSpawn });
  assert.equal(summary.risk.level, 'unknown');
  assert.ok(typeof summary.scannerWarning === 'string');
  assert.match(summary.scannerWarning, /Semgrep scan failed/);
  const report = fs.readFileSync(summary.artifacts.report, 'utf8');
  assert.match(report, /Merge Risk: Unknown/);
});

test('shouldFail returns true for unknown when fail-on is unknown', () => {
  const { shouldFail } = require('../src/risk.js');
  assert.equal(shouldFail('unknown', 'unknown'), true);
});

test('shouldFail returns false for unknown when fail-on is low', () => {
  const { shouldFail } = require('../src/risk.js');
  assert.equal(shouldFail('unknown', 'low'), false);
});

test('shouldFail returns false for unknown when fail-on is high', () => {
  const { shouldFail } = require('../src/risk.js');
  assert.equal(shouldFail('unknown', 'high'), false);
});

test('shouldFail returns false for unknown when fail-on is never', () => {
  const { shouldFail } = require('../src/risk.js');
  assert.equal(shouldFail('unknown', 'never'), false);
});

test('unknownRisk returns correct shape', () => {
  const { unknownRisk } = require('../src/risk.js');
  const risk = unknownRisk('no scanner ran');
  assert.equal(risk.level, 'unknown');
  assert.equal(risk.decision, 'warn');
  assert.equal(risk.score, 0);
  assert.deepEqual(risk.reasons, ['no scanner ran']);
});

test('unknownRisk throws on empty reason', () => {
  const { unknownRisk } = require('../src/risk.js');
  assert.throws(() => unknownRisk(''), /non-empty reason/);
  assert.throws(() => unknownRisk(null), /non-empty reason/);
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

// --- runSemgrepOnFiles ---

test('runSemgrepOnFiles returns skipped:true when files array is empty', () => {
  const fakeSpawn = () => { throw new Error('Should not be called'); };
  const result = runSemgrepOnFiles({ files: [], _spawn: fakeSpawn });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.sarifPath, null);
});

test('runSemgrepOnFiles passes file paths as trailing args to semgrep', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-onfiles-'));
  const outDir = path.join(tmp, 'out');
  let capturedArgs;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = args[args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(0));
    return { status: 0, stdout: '', stderr: '' };
  };

  runSemgrepOnFiles({ files: ['src/auth.js', 'lib/utils.js'], outDir, _spawn: fakeSpawn });
  assert.ok(capturedArgs.includes('src/auth.js'));
  assert.ok(capturedArgs.includes('lib/utils.js'));
  // Should NOT include --no-git-ignore (whole-repo flag not needed for file list)
  assert.ok(!capturedArgs.includes('--no-git-ignore'));
});

test('runSemgrepOnFiles returns ok:true and sarifPath when semgrep exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-onfiles-ok-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = (_cmd, args) => {
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = args[args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(1));
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runSemgrepOnFiles({ files: ['src/auth.js'], outDir, _spawn: fakeSpawn });
  assert.equal(result.ok, true);
  assert.ok(result.sarifPath.endsWith('semgrep-staged.sarif'));
});

test('runSemgrepOnFiles returns ok:false when semgrep exits 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-onfiles-err-'));
  const fakeSpawn = () => ({ status: 2, stdout: '', stderr: 'config error' });
  const result = runSemgrepOnFiles({ cwd: tmp, files: ['src/auth.js'], _spawn: fakeSpawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited with code 2/);
});

test('runSemgrepOnFiles treats exit 1 (findings present) as ok', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-onfiles-exit1-'));
  const outDir = path.join(tmp, 'out');
  const fakeSpawn = (_cmd, args) => {
    fs.mkdirSync(outDir, { recursive: true });
    const sarifPath = args[args.indexOf('--output') + 1];
    fs.writeFileSync(sarifPath, makeSarif(2));
    return { status: 1, stdout: '', stderr: '' };
  };

  const result = runSemgrepOnFiles({ files: ['src/auth.js'], outDir, _spawn: fakeSpawn });
  assert.equal(result.ok, true);
});
