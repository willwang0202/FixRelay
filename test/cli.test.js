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
  assert.match(result.stderr, /Invalid fail-on.*severe/);
});

// ─── compare-outcome subcommand ───────────────────────────────────────────────

function writeOutcomeFixtures(tmp) {
  const prevDir = path.join(tmp, 'prev');
  const currDir = path.join(tmp, 'curr');
  fs.mkdirSync(prevDir, { recursive: true });
  fs.mkdirSync(currDir, { recursive: true });

  const sharedFinding = {
    fingerprint: 'fp-persisted',
    rule_id: 'auth.token.exposure',
    severity: 'high',
    file: 'auth/reset.js',
    line: 8,
    title: 'Token exposure'
  };
  const resolvedFinding = {
    fingerprint: 'fp-resolved',
    rule_id: 'auth.token.exposure',
    severity: 'high',
    file: 'auth/old.js',
    line: 3,
    title: 'Old bug'
  };
  const newFinding = {
    fingerprint: 'fp-new',
    rule_id: 'sql.injection',
    severity: 'critical',
    file: 'db/query.js',
    line: 22,
    title: 'SQL injection'
  };

  const prevFindings = [sharedFinding, resolvedFinding];
  const currFindings = [sharedFinding, newFinding];

  fs.writeFileSync(path.join(prevDir, 'findings.json'), JSON.stringify(prevFindings));
  fs.writeFileSync(path.join(currDir, 'findings.json'), JSON.stringify(currFindings));

  const prevSummary = path.join(prevDir, 'summary.json');
  const currSummary = path.join(currDir, 'summary.json');

  fs.writeFileSync(prevSummary, JSON.stringify({
    artifacts: { findings: path.join(prevDir, 'findings.json') }
  }));
  fs.writeFileSync(currSummary, JSON.stringify({
    artifacts: { findings: path.join(currDir, 'findings.json') }
  }));

  return { prevSummary, currSummary };
}

test('CLI compare-outcome writes fix-outcome.json and exits 1 on regression', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-compare-'));
  const { prevSummary, currSummary } = writeOutcomeFixtures(tmp);
  const outDir = path.join(tmp, 'out');

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'compare-outcome',
    '--previous', prevSummary,
    '--current', currSummary,
    '--out-dir', outDir,
    '--fail-on-new-severity', 'low'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, result.stderr);
  assert.ok(fs.existsSync(path.join(outDir, 'fix-outcome.json')));
  const outcome = JSON.parse(fs.readFileSync(path.join(outDir, 'fix-outcome.json'), 'utf8'));
  assert.equal(outcome.resolvedCount, 1);
  assert.equal(outcome.persistedCount, 1);
  assert.equal(outcome.newCount, 1);
  assert.equal(outcome.gate.triggered, true);
  assert.match(result.stderr, /Regression detected/);
});

test('CLI compare-outcome exits 0 when no regressions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-compare-clean-'));

  const finding = {
    fingerprint: 'fp-1',
    rule_id: 'rule.x',
    severity: 'high',
    file: 'src/auth.js',
    line: 5,
    title: 'Test'
  };
  const dir = path.join(tmp, 'run');
  fs.mkdirSync(dir, { recursive: true });
  const findingsPath = path.join(dir, 'findings.json');
  fs.writeFileSync(findingsPath, JSON.stringify([finding]));
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ artifacts: { findings: findingsPath } }));

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'compare-outcome',
    '--previous', summaryPath,
    '--current', summaryPath, // same run = all persisted, no new
    '--out-dir', path.join(tmp, 'out'),
    '--fail-on-new-severity', 'low'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
});

test('CLI compare-outcome exits 2 when --previous is missing', () => {
  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'compare-outcome',
    '--current', '/tmp/curr.json'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--previous is required/);
});

// ─── hook subcommand ──────────────────────────────────────────────────────────

test('CLI hook install writes pre-commit hook into a git repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-hook-'));
  // Create a minimal git repo structure
  fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true });

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'hook', 'install',
    '--repo', tmp,
    '--fail-on', 'critical'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hookPath));
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('# FixRelay pre-commit security gate'));
  assert.ok(content.includes('--fail-on critical'));
});

test('CLI hook uninstall removes FixRelay hook', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-uninstall-'));
  fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true });

  // Install first
  cp.spawnSync(process.execPath, ['bin/fixrelay.js', 'hook', 'install', '--repo', tmp], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hookPath));

  // Uninstall
  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'hook', 'uninstall',
    '--repo', tmp
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(hookPath));
});

test('CLI hook install exits 2 when non-FixRelay hook exists without --force', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-force-'));
  fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true });
  // Write a non-FixRelay hook
  fs.writeFileSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "husky"\n');

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'hook', 'install',
    '--repo', tmp
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /not managed by FixRelay/);
});

test('CLI hook install succeeds with --force when non-FixRelay hook exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-cli-force-ok-'));
  fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "husky"\n');

  const result = cp.spawnSync(process.execPath, [
    'bin/fixrelay.js',
    'hook', 'install',
    '--repo', tmp,
    '--force'
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const content = fs.readFileSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.ok(content.includes('FixRelay'));
});
