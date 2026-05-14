const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function writeFixtureFiles(tmp) {
  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const diffPath = path.join(tmp, 'pr.diff');

  fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Semgrep',
            rules: [
              {
                id: 'auth.token.exposure',
                shortDescription: { text: 'Token exposure' },
                properties: { 'security-severity': '8.1', tags: ['cwe-200'] }
              }
            ]
          }
        },
        results: [
          {
            ruleId: 'auth.token.exposure',
            message: { text: 'Reset token is exposed in a response.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'auth/reset.js' },
                  region: { startLine: 8 }
                }
              }
            ]
          }
        ]
      }
    ]
  }), 'utf8');

  fs.writeFileSync(diffPath, [
    'diff --git a/auth/reset.js b/auth/reset.js',
    '--- a/auth/reset.js',
    '+++ b/auth/reset.js',
    '@@ -7,0 +8,2 @@',
    '+res.json({ token });',
    '+return;',
    ''
  ].join('\n'), 'utf8');

  return { sarifPath, diffPath };
}

test('CLI generate writes artifacts and prints JSON summary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-'));
  const { sarifPath, diffPath } = writeFixtureFiles(tmp);
  const outDir = path.join(tmp, 'out');

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'generate',
    '--sarif',
    sarifPath,
    '--diff-file',
    diffPath,
    '--out-dir',
    outDir,
    '--fail-on',
    'never',
    '--pr-title',
    'Auth reset PR'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.risk.level, 'high');
  assert.equal(fs.existsSync(path.join(outDir, 'merge-risk-report.md')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'agent-fix-tasks.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'summary.json')), true);
});

test('CLI generate exits non-zero when risk meets fail-on threshold', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-fail-'));
  const { sarifPath, diffPath } = writeFixtureFiles(tmp);

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'generate',
    '--sarif',
    sarifPath,
    '--diff-file',
    diffPath,
    '--out-dir',
    path.join(tmp, 'out'),
    '--fail-on',
    'high'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /FixRelay blocked merge/);
});

test('CLI generate checks all findings with entire-repo scope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-scope-'));
  const { sarifPath, diffPath } = writeFixtureFiles(tmp);
  fs.writeFileSync(diffPath, '', 'utf8');

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'generate',
    '--sarif',
    sarifPath,
    '--diff-file',
    diffPath,
    '--out-dir',
    path.join(tmp, 'out'),
    '--scope',
    'entire-repo',
    '--fail-on',
    'high'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.scope, 'entire-repo');
  assert.equal(summary.findingCount, 1);
  assert.equal(summary.totalFindingCount, 1);
  assert.equal(summary.shouldFail, true);
});

test('CLI generate reports configuration error for invalid fail-on threshold', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-invalid-'));
  const { sarifPath, diffPath } = writeFixtureFiles(tmp);

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'generate',
    '--sarif',
    sarifPath,
    '--diff-file',
    diffPath,
    '--out-dir',
    path.join(tmp, 'out'),
    '--fail-on',
    'severe'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid fail-on threshold: severe/);
});
