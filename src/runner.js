const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { annotateFindings, applyScannerFileFallback, parseUnifiedDiff } = require('./diff.js');
const { loadFindingsFromSarif, loadFindingsFromScannerJson, serializeFinding } = require('./findings.js');
const { DEFAULT_PROTECTED_PATHS } = require('./paths.js');
const { generateReport } = require('./report.js');
const { scoreRisk, shouldFail } = require('./risk.js');
const { generateAgentTasks, generatePromptBundle } = require('./tasks.js');

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readDiff(options) {
  if (options.diffFile) return fs.readFileSync(options.diffFile, 'utf8');
  if (options.diff) {
    return cp.execFileSync('git', ['diff', '--unified=0', options.diff], {
      cwd: options.cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  }
  try {
    return cp.execFileSync('git', ['diff', '--unified=0', 'HEAD'], {
      cwd: options.cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return '';
  }
}

function runFixRelay(options = {}) {
  const sarifPaths = options.sarifPaths || [];
  const scannerJsonPaths = options.scannerJsonPaths || [];
  const findings = [];

  for (const sarifPath of sarifPaths) {
    findings.push(...loadFindingsFromSarif(readJsonFile(sarifPath), sarifPath));
  }
  for (const jsonPath of scannerJsonPaths) {
    findings.push(...loadFindingsFromScannerJson(readJsonFile(jsonPath), jsonPath));
  }

  const diffContext = applyScannerFileFallback(parseUnifiedDiff(readDiff(options)), findings);
  const risk = scoreRisk(findings, diffContext, {
    protectedPaths: options.protectedPaths || DEFAULT_PROTECTED_PATHS
  });
  const annotatedFindings = annotateFindings(findings, diffContext, risk);
  const tasks = generateAgentTasks(annotatedFindings, diffContext, risk, {
    cwd: options.cwd,
    packageManager: options.packageManager
  });
  const report = generateReport(annotatedFindings, diffContext, risk, tasks, {
    prTitle: options.prTitle,
    prBody: options.prBody
  });
  const prompt = generatePromptBundle(tasks);
  const normalizedFindings = annotatedFindings.map(serializeFinding);

  const outDir = options.outDir || 'fixrelay-out';
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'merge-risk-report.md');
  const tasksPath = path.join(outDir, 'agent-fix-tasks.json');
  const summaryPath = path.join(outDir, 'summary.json');
  const findingsPath = path.join(outDir, 'normalized-findings.json');
  const promptPath = path.join(outDir, 'prompt.md');

  const summary = {
    findingCount: findings.length,
    risk,
    decision: risk.decision,
    shouldFail: shouldFail(risk.level, options.failOn),
    artifacts: {
      report: reportPath,
      tasks: tasksPath,
      summary: summaryPath,
      findings: findingsPath,
      prompt: promptPath
    }
  };

  fs.writeFileSync(reportPath, report, 'utf8');
  fs.writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(findingsPath, `${JSON.stringify(normalizedFindings, null, 2)}\n`, 'utf8');
  fs.writeFileSync(promptPath, `${prompt}\n`, 'utf8');

  return summary;
}

module.exports = {
  readDiff,
  readJsonFile,
  runFixRelay
};
