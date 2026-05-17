const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compareFindings, loadOutcome, severityGate } = require('../src/outcome.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFinding(overrides = {}) {
  return {
    fingerprint: 'scanner:rule.x:auth/reset.js:8',
    rule_id: 'rule.x',
    severity: 'high',
    file: 'auth/reset.js',
    line: 8,
    title: 'Token exposure',
    ...overrides
  };
}

// ─── compareFindings ─────────────────────────────────────────────────────────

test('compareFindings: empty both sides returns zeros', () => {
  const result = compareFindings([], []);
  assert.equal(result.resolvedCount, 0);
  assert.equal(result.persistedCount, 0);
  assert.equal(result.newCount, 0);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.persisted, []);
  assert.deepEqual(result.new, []);
});

test('compareFindings: all findings in previous only are resolved', () => {
  const prev = [makeFinding({ fingerprint: 'fp-1' }), makeFinding({ fingerprint: 'fp-2' })];
  const result = compareFindings(prev, []);
  assert.equal(result.resolvedCount, 2);
  assert.equal(result.persistedCount, 0);
  assert.equal(result.newCount, 0);
});

test('compareFindings: all findings in current only are new', () => {
  const curr = [makeFinding({ fingerprint: 'fp-1' }), makeFinding({ fingerprint: 'fp-2' })];
  const result = compareFindings([], curr);
  assert.equal(result.resolvedCount, 0);
  assert.equal(result.persistedCount, 0);
  assert.equal(result.newCount, 2);
});

test('compareFindings: fingerprint in both runs is persisted', () => {
  const finding = makeFinding({ fingerprint: 'fp-shared' });
  const result = compareFindings([finding], [finding]);
  assert.equal(result.persistedCount, 1);
  assert.equal(result.resolvedCount, 0);
  assert.equal(result.newCount, 0);
});

test('compareFindings: mixed resolved, persisted, new', () => {
  const prev = [
    makeFinding({ fingerprint: 'fp-keep', title: 'Kept' }),
    makeFinding({ fingerprint: 'fp-fixed', title: 'Fixed' })
  ];
  const curr = [
    makeFinding({ fingerprint: 'fp-keep', title: 'Kept' }),
    makeFinding({ fingerprint: 'fp-regression', title: 'New bug', severity: 'critical' })
  ];
  const result = compareFindings(prev, curr);
  assert.equal(result.resolvedCount, 1);
  assert.equal(result.persistedCount, 1);
  assert.equal(result.newCount, 1);
  assert.equal(result.resolved[0].fingerprint, 'fp-fixed');
  assert.equal(result.persisted[0].fingerprint, 'fp-keep');
  assert.equal(result.new[0].fingerprint, 'fp-regression');
});

test('compareFindings: deduplicate fingerprints within a run', () => {
  // Same fingerprint twice in previous — should count as 1
  const prev = [
    makeFinding({ fingerprint: 'fp-dup' }),
    makeFinding({ fingerprint: 'fp-dup' })
  ];
  const result = compareFindings(prev, []);
  assert.equal(result.previousFindingCount, 1, 'deduplicated to 1');
  assert.equal(result.resolvedCount, 1);
});

test('compareFindings: slim projection includes expected fields', () => {
  const finding = makeFinding({ fingerprint: 'fp-1', severity: 'medium', line: 42 });
  const result = compareFindings([], [finding]);
  const slim = result.new[0];
  assert.ok('fingerprint' in slim);
  assert.ok('ruleId' in slim);
  assert.ok('severity' in slim);
  assert.ok('file' in slim);
  assert.ok('line' in slim);
  assert.ok('title' in slim);
  // Should NOT include raw SARIF data or message
  assert.ok(!('raw' in slim));
  assert.ok(!('message' in slim));
});

test('compareFindings: throws when a finding is missing fingerprint', () => {
  const badFinding = { severity: 'high', title: 'No fingerprint' };
  assert.throws(
    () => compareFindings([badFinding], []),
    /missing fingerprint/
  );
});

test('compareFindings: throws on non-array previous', () => {
  assert.throws(() => compareFindings(null, []), /previousFindings must be an array/);
});

test('compareFindings: throws on non-array current', () => {
  assert.throws(() => compareFindings([], 'bad'), /currentFindings must be an array/);
});

test('compareFindings: previousFindingCount and currentFindingCount are correct', () => {
  const prev = [makeFinding({ fingerprint: 'fp-1' }), makeFinding({ fingerprint: 'fp-2' })];
  const curr = [makeFinding({ fingerprint: 'fp-2' }), makeFinding({ fingerprint: 'fp-3' })];
  const result = compareFindings(prev, curr);
  assert.equal(result.previousFindingCount, 2);
  assert.equal(result.currentFindingCount, 2);
});

// ─── severityGate ────────────────────────────────────────────────────────────

function makeOutcome(newFindings = []) {
  return {
    previousFindingCount: 0,
    currentFindingCount: newFindings.length,
    resolvedCount: 0,
    persistedCount: 0,
    newCount: newFindings.length,
    resolved: [],
    persisted: [],
    new: newFindings
  };
}

test('severityGate: never threshold never triggers', () => {
  const outcome = makeOutcome([{ fingerprint: 'fp', severity: 'critical' }]);
  const gate = severityGate(outcome, { failOnNewSeverity: 'never' });
  assert.equal(gate.triggered, false);
  assert.deepEqual(gate.triggeringSeverities, []);
});

test('severityGate: low threshold triggers on any new finding', () => {
  const outcome = makeOutcome([{ fingerprint: 'fp', severity: 'low' }]);
  const gate = severityGate(outcome, { failOnNewSeverity: 'low' });
  assert.equal(gate.triggered, true);
  assert.deepEqual(gate.triggeringSeverities, ['low']);
});

test('severityGate: high threshold does not trigger on medium', () => {
  const outcome = makeOutcome([{ fingerprint: 'fp', severity: 'medium' }]);
  const gate = severityGate(outcome, { failOnNewSeverity: 'high' });
  assert.equal(gate.triggered, false);
});

test('severityGate: high threshold triggers on critical', () => {
  const outcome = makeOutcome([{ fingerprint: 'fp', severity: 'critical' }]);
  const gate = severityGate(outcome, { failOnNewSeverity: 'high' });
  assert.equal(gate.triggered, true);
  assert.ok(gate.triggeringSeverities.includes('critical'));
});

test('severityGate: no new findings never triggers', () => {
  const outcome = makeOutcome([]);
  const gate = severityGate(outcome, { failOnNewSeverity: 'low' });
  assert.equal(gate.triggered, false);
});

test('severityGate: deduplicates triggering severities', () => {
  const outcome = makeOutcome([
    { fingerprint: 'fp-1', severity: 'high' },
    { fingerprint: 'fp-2', severity: 'high' },
    { fingerprint: 'fp-3', severity: 'critical' }
  ]);
  const gate = severityGate(outcome, { failOnNewSeverity: 'high' });
  assert.equal(gate.triggered, true);
  // high and critical, not high twice
  assert.equal(gate.triggeringSeverities.length, 2);
});

test('severityGate: throws on invalid failOnNewSeverity', () => {
  const outcome = makeOutcome([]);
  assert.throws(
    () => severityGate(outcome, { failOnNewSeverity: 'massive' }),
    /Invalid failOnNewSeverity/
  );
});

test('severityGate: defaults to low when not specified', () => {
  const outcome = makeOutcome([{ fingerprint: 'fp', severity: 'low' }]);
  const gate = severityGate(outcome);
  assert.equal(gate.triggered, true);
});

// ─── loadOutcome ──────────────────────────────────────────────────────────────

function makeFixtures() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-outcome-'));

  const prevDir = path.join(tmp, 'prev');
  const currDir = path.join(tmp, 'curr');
  fs.mkdirSync(prevDir, { recursive: true });
  fs.mkdirSync(currDir, { recursive: true });

  const prevFindings = [
    makeFinding({ fingerprint: 'fp-fixed', title: 'Fixed bug' }),
    makeFinding({ fingerprint: 'fp-persisted', title: 'Still there' })
  ];
  const currFindings = [
    makeFinding({ fingerprint: 'fp-persisted', title: 'Still there' }),
    makeFinding({ fingerprint: 'fp-new', title: 'Regression', severity: 'critical' })
  ];

  const prevFindingsPath = path.join(prevDir, 'normalized-findings.json');
  const currFindingsPath = path.join(currDir, 'normalized-findings.json');
  fs.writeFileSync(prevFindingsPath, JSON.stringify(prevFindings));
  fs.writeFileSync(currFindingsPath, JSON.stringify(currFindings));

  const prevSummaryPath = path.join(prevDir, 'summary.json');
  const currSummaryPath = path.join(currDir, 'summary.json');
  fs.writeFileSync(prevSummaryPath, JSON.stringify({ artifacts: { findings: prevFindingsPath } }));
  fs.writeFileSync(currSummaryPath, JSON.stringify({ artifacts: { findings: currFindingsPath } }));

  return { prevSummaryPath, currSummaryPath, prevDir, currDir };
}

test('loadOutcome: correctly classifies findings from summary JSON files', () => {
  const { prevSummaryPath, currSummaryPath } = makeFixtures();
  const result = loadOutcome({ previousSummaryPath: prevSummaryPath, currentSummaryPath: currSummaryPath });

  assert.equal(result.resolvedCount, 1);
  assert.equal(result.persistedCount, 1);
  assert.equal(result.newCount, 1);
  assert.equal(result.new[0].fingerprint, 'fp-new');
});

test('loadOutcome: includes gate with failOnNewSeverity', () => {
  const { prevSummaryPath, currSummaryPath } = makeFixtures();
  const result = loadOutcome({
    previousSummaryPath: prevSummaryPath,
    currentSummaryPath: currSummaryPath,
    failOnNewSeverity: 'high'
  });
  assert.equal(result.gate.failOnNewSeverity, 'high');
  assert.equal(result.gate.triggered, true); // new finding is critical, meets high threshold
});

test('loadOutcome: includes generatedAt timestamp', () => {
  const { prevSummaryPath, currSummaryPath } = makeFixtures();
  const result = loadOutcome({ previousSummaryPath: prevSummaryPath, currentSummaryPath: currSummaryPath });
  assert.ok(typeof result.generatedAt === 'string');
  assert.ok(!isNaN(Date.parse(result.generatedAt)));
});

test('loadOutcome: resolves relative findings paths against summary directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-outcome-rel-'));
  const prevDir = path.join(tmp, 'prev');
  const currDir = path.join(tmp, 'curr');
  fs.mkdirSync(prevDir, { recursive: true });
  fs.mkdirSync(currDir, { recursive: true });

  const findings = [makeFinding({ fingerprint: 'fp-1' })];
  fs.writeFileSync(path.join(prevDir, 'findings.json'), JSON.stringify(findings));
  fs.writeFileSync(path.join(currDir, 'findings.json'), JSON.stringify(findings));

  // Use relative paths in summary — relative to summary file dir
  const prevSummary = path.join(prevDir, 'summary.json');
  const currSummary = path.join(currDir, 'summary.json');
  fs.writeFileSync(prevSummary, JSON.stringify({ artifacts: { findings: 'findings.json' } }));
  fs.writeFileSync(currSummary, JSON.stringify({ artifacts: { findings: 'findings.json' } }));

  const result = loadOutcome({ previousSummaryPath: prevSummary, currentSummaryPath: currSummary });
  assert.equal(result.persistedCount, 1);
});

test('loadOutcome: throws when previousSummaryPath is missing', () => {
  assert.throws(() => loadOutcome({ currentSummaryPath: '/tmp/curr.json' }), /previousSummaryPath is required/);
});

test('loadOutcome: throws when summary.json has no artifacts.findings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-outcome-noart-'));
  const prevPath = path.join(tmp, 'prev.json');
  const currPath = path.join(tmp, 'curr.json');
  fs.writeFileSync(prevPath, JSON.stringify({ scope: 'pr' })); // no artifacts.findings
  fs.writeFileSync(currPath, JSON.stringify({ artifacts: { findings: '/nonexistent/file.json' } }));
  assert.throws(
    () => loadOutcome({ previousSummaryPath: prevPath, currentSummaryPath: currPath }),
    /no artifacts\.findings/
  );
});

test('loadOutcome: throws when findings file does not exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-outcome-missing-'));
  const summaryPath = path.join(tmp, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ artifacts: { findings: '/nonexistent/findings.json' } }));
  assert.throws(
    () => loadOutcome({ previousSummaryPath: summaryPath, currentSummaryPath: summaryPath }),
    /Cannot read findings file/
  );
});

test('loadOutcome: _readFile injection works for unit testing without disk', () => {
  const prevFindings = [makeFinding({ fingerprint: 'fp-prev' })];
  const currFindings = [makeFinding({ fingerprint: 'fp-curr' })];

  const files = {
    '/prev/summary.json': JSON.stringify({ artifacts: { findings: '/prev/findings.json' } }),
    '/prev/findings.json': JSON.stringify(prevFindings),
    '/curr/summary.json': JSON.stringify({ artifacts: { findings: '/curr/findings.json' } }),
    '/curr/findings.json': JSON.stringify(currFindings)
  };

  const result = loadOutcome({
    previousSummaryPath: '/prev/summary.json',
    currentSummaryPath: '/curr/summary.json',
    _readFile: (p) => {
      if (files[p]) return files[p];
      throw new Error(`File not found: ${p}`);
    }
  });

  assert.equal(result.resolvedCount, 1);
  assert.equal(result.newCount, 1);
});
