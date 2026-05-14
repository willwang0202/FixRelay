const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  generateAgentTasks,
  generateReport,
  loadFindingsFromSarif,
  parseUnifiedDiff,
  runFixRelay,
  scoreRisk,
  shouldFail
} = require('../src/index.js');

function sampleSarif() {
  return {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Semgrep',
            rules: [
              {
                id: 'javascript.express.security.audit.xss.direct-response-write',
                shortDescription: { text: 'Unsanitized response body' },
                defaultConfiguration: { level: 'error' },
                properties: {
                  'security-severity': '8.8',
                  tags: ['security', 'cwe-79']
                }
              }
            ]
          }
        },
        results: [
          {
            ruleId: 'javascript.express.security.audit.xss.direct-response-write',
            level: 'error',
            message: { text: 'User-controlled value is written to response.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'auth/reset.js' },
                  region: { startLine: 12 }
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

function sampleDiff() {
  return [
    'diff --git a/auth/reset.js b/auth/reset.js',
    'index 1111111..2222222 100644',
    '--- a/auth/reset.js',
    '+++ b/auth/reset.js',
    '@@ -10,0 +11,3 @@ function reset(req, res) {',
    '+  const next = req.query.next;',
    '+  res.send(next);',
    '+}',
    ''
  ].join('\n');
}

test('normalizes SARIF findings with scanner, severity, file, line, and CWE tags', () => {
  const findings = loadFindingsFromSarif(sampleSarif(), 'semgrep.sarif');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].scanner, 'Semgrep');
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].file, 'auth/reset.js');
  assert.equal(findings[0].line, 12);
  assert.deepEqual(findings[0].cwe, ['cwe-79']);
});

test('parses unified diff files and changed lines', () => {
  const context = parseUnifiedDiff(sampleDiff());

  assert.deepEqual([...context.changedFiles], ['auth/reset.js']);
  assert.equal(context.changedLinesByFile.get('auth/reset.js').has(12), true);
  assert.equal(context.hasTestChanges, false);
});

test('scores high risk for protected changed finding without tests', () => {
  const findings = loadFindingsFromSarif(sampleSarif(), 'semgrep.sarif');
  const diffContext = parseUnifiedDiff(sampleDiff());
  const risk = scoreRisk(findings, diffContext, {
    protectedPaths: ['auth/', 'billing/', '.github/workflows/']
  });

  assert.equal(risk.level, 'high');
  assert.equal(risk.decision, 'block');
  assert.match(risk.reasons.join('\n'), /High severity finding/);
  assert.match(risk.reasons.join('\n'), /protected path/);
  assert.match(risk.reasons.join('\n'), /No test changes/);
});

test('generates PR report and agent task JSON with validation guidance', () => {
  const findings = loadFindingsFromSarif(sampleSarif(), 'semgrep.sarif');
  const diffContext = parseUnifiedDiff(sampleDiff());
  const risk = scoreRisk(findings, diffContext, {
    protectedPaths: ['auth/']
  });

  const tasks = generateAgentTasks(findings, diffContext, risk, {
    packageManager: 'npm'
  });
  const report = generateReport(findings, diffContext, risk, tasks, {
    prTitle: 'Reset flow change'
  });

  assert.equal(tasks[0].task_type, 'security_fix');
  assert.deepEqual(tasks[0].target_files, ['auth/reset.js']);
  assert.match(tasks[0].validation_commands.join('\n'), /npm test/);
  assert.match(report, /Merge Risk: High/);
  assert.match(report, /AI Agent Fix Prompt/);
  assert.match(report, /auth\/reset\.js/);
});

test('runFixRelay writes report, task JSON, and summary artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-core-'));
  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const diffPath = path.join(tmp, 'pr.diff');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(sarifPath, JSON.stringify(sampleSarif()), 'utf8');
  fs.writeFileSync(diffPath, sampleDiff(), 'utf8');

  const summary = runFixRelay({
    sarifPaths: [sarifPath],
    diffFile: diffPath,
    outDir,
    failOn: 'never',
    prTitle: 'Reset flow change'
  });

  assert.equal(summary.risk.level, 'high');
  assert.equal(summary.findingCount, 1);
  assert.equal(fs.existsSync(path.join(outDir, 'merge-risk-report.md')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'agent-fix-tasks.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'summary.json')), true);
});

test('runFixRelay focuses on PR-relevant findings by default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-pr-scope-'));
  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const diffPath = path.join(tmp, 'empty.diff');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(sarifPath, JSON.stringify(sampleSarif()), 'utf8');
  fs.writeFileSync(diffPath, '', 'utf8');

  const summary = runFixRelay({
    sarifPaths: [sarifPath],
    diffFile: diffPath,
    outDir,
    failOn: 'high'
  });

  const report = fs.readFileSync(path.join(outDir, 'merge-risk-report.md'), 'utf8');
  const prompt = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8');
  const normalized = JSON.parse(fs.readFileSync(path.join(outDir, 'normalized-findings.json'), 'utf8'));
  const tasks = JSON.parse(fs.readFileSync(path.join(outDir, 'agent-fix-tasks.json'), 'utf8'));

  assert.equal(summary.scope, 'pr');
  assert.equal(summary.findingCount, 0);
  assert.equal(summary.totalFindingCount, 1);
  assert.equal(summary.risk.level, 'low');
  assert.equal(summary.decision, 'allow');
  assert.equal(summary.shouldFail, false);
  assert.deepEqual(normalized, []);
  assert.deepEqual(tasks, []);
  assert.match(report, /No PR-relevant scanner findings/);
  assert.match(prompt, /No PR-relevant scanner findings/);
  assert.doesNotMatch(summary.risk.reasons.join('\n'), /Finding is in changed file/);
});

test('runFixRelay checks all scanner findings when scope is entire-repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-entire-scope-'));
  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const diffPath = path.join(tmp, 'empty.diff');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(sarifPath, JSON.stringify(sampleSarif()), 'utf8');
  fs.writeFileSync(diffPath, '', 'utf8');

  const summary = runFixRelay({
    sarifPaths: [sarifPath],
    diffFile: diffPath,
    outDir,
    failOn: 'high',
    scope: 'entire-repo'
  });

  const normalized = JSON.parse(fs.readFileSync(path.join(outDir, 'normalized-findings.json'), 'utf8'));

  assert.equal(summary.scope, 'entire-repo');
  assert.equal(summary.findingCount, 1);
  assert.equal(summary.totalFindingCount, 1);
  assert.equal(summary.risk.level, 'high');
  assert.equal(summary.shouldFail, true);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].is_in_diff, false);
});

test('runFixRelay writes normalized findings and standalone prompt artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-structured-'));
  const sarif = sampleSarif();
  sarif.runs[0].tool.driver.rules[0].helpUri = 'https://semgrep.dev/r/xss';
  sarif.runs[0].results[0].partialFingerprints = {
    primaryLocationLineHash: 'abc123'
  };

  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const diffPath = path.join(tmp, 'pr.diff');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(sarifPath, JSON.stringify(sarif), 'utf8');
  fs.writeFileSync(diffPath, sampleDiff(), 'utf8');

  const summary = runFixRelay({
    sarifPaths: [sarifPath],
    diffFile: diffPath,
    outDir,
    failOn: 'never',
    prTitle: 'Reset flow change'
  });

  const findingsPath = path.join(outDir, 'normalized-findings.json');
  const promptPath = path.join(outDir, 'prompt.md');
  assert.equal(summary.artifacts.findings, findingsPath);
  assert.equal(summary.artifacts.prompt, promptPath);
  assert.equal(fs.existsSync(findingsPath), true);
  assert.equal(fs.existsSync(promptPath), true);

  const normalized = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.equal(normalized[0].scanner, 'Semgrep');
  assert.equal(normalized[0].rule_id, 'javascript.express.security.audit.xss.direct-response-write');
  assert.equal(normalized[0].fingerprint, 'abc123');
  assert.equal(normalized[0].help_uri, 'https://semgrep.dev/r/xss');
  assert.equal(normalized[0].is_in_diff, true);
  assert.equal(normalized[0].is_on_changed_line, true);
  assert.equal(normalized[0].is_blocking, true);

  const prompt = fs.readFileSync(promptPath, 'utf8');
  assert.match(prompt, /You are fixing a security issue in this repository/);
  assert.match(prompt, /Target files: auth\/reset\.js/);
});

test('rejects invalid fail-on thresholds instead of treating them as blocking', () => {
  assert.throws(
    () => shouldFail('low', 'severe'),
    /Invalid fail-on threshold/
  );
});

test('uses scanner file paths as changed-file fallback when diff context is unavailable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-no-diff-'));
  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(sarifPath, JSON.stringify(sampleSarif()), 'utf8');

  const summary = runFixRelay({
    sarifPaths: [sarifPath],
    cwd: tmp,
    outDir,
    failOn: 'never'
  });

  assert.equal(summary.risk.level, 'high');
  assert.match(summary.risk.reasons.join('\n'), /Finding is in changed file auth\/reset\.js/);
});
