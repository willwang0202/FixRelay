const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { annotateFindings, applyScannerFileFallback, parseUnifiedDiff } = require('./diff.js');
const { loadFindingsFromSarif, loadFindingsFromScannerJson, serializeFinding } = require('./findings.js');
const { runLlmReview } = require('./llm/review.js');
const { DEFAULT_PROTECTED_PATHS } = require('./paths.js');
const { runSemgrep, semgrepAvailable } = require('./scanner.js');
const { generateReport } = require('./report.js');
const { scoreRisk, shouldFail } = require('./risk.js');
const { generateAgentTasks, generatePromptBundle } = require('./tasks.js');

const DEFAULT_SCOPE = 'pr';

function readJsonFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read file ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot parse JSON from ${file}: ${error.message}`);
  }
}

function normalizeScope(scope = DEFAULT_SCOPE) {
  const value = String(scope || DEFAULT_SCOPE).trim().toLowerCase();
  if (value === 'pr' || value === 'pull-request' || value === 'pull_request') return 'pr';
  if (
    value === 'entire-repo' ||
    value === 'entire_repo' ||
    value === 'repository' ||
    value === 'repo' ||
    value === 'all'
  ) {
    return 'entire-repo';
  }
  throw new Error(`Invalid scope: ${scope}`);
}

function selectFindingsForScope(findings, diffContext, scope) {
  if (scope === 'entire-repo') return findings;
  return findings.filter((finding) => Boolean(finding.file && diffContext.changedFiles?.has(finding.file)));
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

async function runFixRelay(options = {}) {
  const sarifPaths = [...(options.sarifPaths || [])];
  const scannerJsonPaths = options.scannerJsonPaths || [];
  const findings = [];
  const scope = normalizeScope(options.scope);

  const runSemgrepScan = options.runSemgrep !== false;
  const noExplicitFindings = sarifPaths.length === 0 && scannerJsonPaths.length === 0;
  let scannerWarning = null;
  if (runSemgrepScan && noExplicitFindings) {
    const cwd = options.cwd || process.cwd();
    const outDir = options.outDir || 'fixrelay-out';
    if (semgrepAvailable(options._spawn)) {
      process.stderr.write('FixRelay: running Semgrep free audit (--config auto)...\n');
      const result = runSemgrep({
        cwd,
        config: options.semgrepConfig || 'auto',
        outDir,
        _spawn: options._spawn
      });
      if (result.ok) {
        sarifPaths.push(result.sarifPath);
      } else {
        scannerWarning = `Semgrep scan failed (${result.error}). No findings were loaded — results may not reflect actual risk.`;
        process.stderr.write(`FixRelay warning: ${scannerWarning}\n`);
      }
    } else {
      scannerWarning = 'Semgrep is not installed. No scanner was run — results may not reflect actual risk. Install Semgrep or pass --sarif/--scanner-json explicitly.';
      process.stderr.write(`FixRelay warning: ${scannerWarning}\n`);
    }
  }

  for (const sarifPath of sarifPaths) {
    findings.push(...loadFindingsFromSarif(readJsonFile(sarifPath), sarifPath));
  }
  for (const jsonPath of scannerJsonPaths) {
    findings.push(...loadFindingsFromScannerJson(readJsonFile(jsonPath), jsonPath));
  }

  const hasExplicitDiff = Boolean(options.diffFile || options.diff);
  let diffContext = parseUnifiedDiff(readDiff(options));
  if (!hasExplicitDiff && scope === 'pr') {
    diffContext = applyScannerFileFallback(diffContext, findings);
  }
  const scopedFindings = selectFindingsForScope(findings, diffContext, scope);
  let risk = scoreRisk(scopedFindings, diffContext, {
    protectedPaths: options.protectedPaths || DEFAULT_PROTECTED_PATHS,
    scope,
    totalFindingCount: findings.length
  });

  const outDir = options.outDir || 'fixrelay-out';
  fs.mkdirSync(outDir, { recursive: true });

  let llmReviewResult = null;
  if (options.llmReview && options.llmEndpoint && options.llmModel && options.llmApiKey) {
    llmReviewResult = await runLlmReview({
      findings: scopedFindings,
      risk,
      options: {
        endpoint: options.llmEndpoint,
        model: options.llmModel,
        apiKey: options.llmApiKey,
        timeoutMs: options.llmTimeoutMs,
        maxSnippetLines: options.llmMaxSnippetLines,
        prTitle: options.prTitle
      },
      cwd: options.cwd || process.cwd(),
      httpClient: options._httpClient
    });
    risk = llmReviewResult.downgradedRisk;
    if (llmReviewResult.status === 'failed') {
      process.stderr.write(`FixRelay warning: LLM review failed (${llmReviewResult.review?.error}); using deterministic risk.\n`);
    }
  } else if (options.llmReview) {
    process.stderr.write('FixRelay warning: llm-review enabled but llm-endpoint, llm-model, or LLM_API_KEY is missing; skipping LLM review.\n');
  }

  const annotatedFindings = annotateFindings(scopedFindings, diffContext, risk);
  const emptyPromptMessage = scope === 'pr' && findings.length > 0 && scopedFindings.length === 0
    ? 'No PR-relevant scanner findings were found in changed files.'
    : undefined;
  const tasks = generateAgentTasks(annotatedFindings, diffContext, risk, {
    cwd: options.cwd,
    packageManager: options.packageManager
  });
  const report = generateReport(annotatedFindings, diffContext, risk, tasks, {
    prTitle: options.prTitle,
    prBody: options.prBody,
    scope,
    totalFindingCount: findings.length,
    llmReview: llmReviewResult,
    scannerWarning
  });
  const prompt = generatePromptBundle(tasks, { emptyMessage: emptyPromptMessage });
  const normalizedFindings = annotatedFindings.map(serializeFinding);

  const reportPath = path.join(outDir, 'merge-risk-report.md');
  const tasksPath = path.join(outDir, 'agent-fix-tasks.json');
  const summaryPath = path.join(outDir, 'summary.json');
  const findingsPath = path.join(outDir, 'normalized-findings.json');
  const promptPath = path.join(outDir, 'prompt.md');

  const artifacts = { report: reportPath, tasks: tasksPath, summary: summaryPath, findings: findingsPath, prompt: promptPath };

  if (llmReviewResult?.review) {
    const llmReviewPath = path.join(outDir, 'llm-review.json');
    fs.writeFileSync(llmReviewPath, `${JSON.stringify(llmReviewResult.review, null, 2)}\n`, 'utf8');
    artifacts.llmReview = llmReviewPath;
  }

  const summary = {
    scope,
    findingCount: scopedFindings.length,
    totalFindingCount: findings.length,
    risk,
    decision: risk.decision,
    shouldFail: shouldFail(risk.level, options.failOn),
    ...(scannerWarning ? { scannerWarning } : {}),
    artifacts
  };

  fs.writeFileSync(reportPath, report, 'utf8');
  fs.writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(findingsPath, `${JSON.stringify(normalizedFindings, null, 2)}\n`, 'utf8');
  fs.writeFileSync(promptPath, `${prompt}\n`, 'utf8');

  return summary;
}

module.exports = {
  DEFAULT_SCOPE,
  normalizeScope,
  readDiff,
  readJsonFile,
  runFixRelay,
  selectFindingsForScope
};
