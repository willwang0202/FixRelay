const { DEFAULT_PROTECTED_PATHS, isProtectedPath } = require('./paths.js');

const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
// 'unknown' is a sentinel — no scanner ran, risk cannot be assessed.
// It sits outside RISK_ORDER so threshold comparisons don't apply to it.

function severityPoints(severity) {
  return {
    low: 10,
    medium: 22,
    high: 35,
    critical: 55
  }[severity] || 10;
}

function titleCase(value) {
  const text = String(value || 'low');
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function unknownRisk(reason) {
  if (!reason) throw new Error('unknownRisk requires a non-empty reason');
  return {
    score: 0,
    level: 'unknown',
    decision: 'warn',
    reasons: [String(reason)]
  };
}

function riskLevel(score, findings) {
  if (score >= 100 || findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  if (findings.some((finding) => finding.severity === 'high')) return 'high';
  if (score >= 70) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function scoreRisk(findings, diffContext, options = {}) {
  const protectedPaths = options.protectedPaths || DEFAULT_PROTECTED_PATHS;
  const reasons = [];
  let score = 0;

  for (const finding of findings) {
    score += severityPoints(finding.severity);
    if (finding.severity === 'high' || finding.severity === 'critical') {
      reasons.push(`${titleCase(finding.severity)} severity finding from ${finding.scanner}: ${finding.title}`);
    }

    if (finding.file && diffContext.changedFiles?.has(finding.file)) {
      score += 15;
      reasons.push(`Finding is in changed file ${finding.file}`);
    }

    if (
      finding.file &&
      finding.line &&
      diffContext.changedLinesByFile?.get(finding.file)?.has(finding.line)
    ) {
      score += 15;
      reasons.push(`Finding is on changed line ${finding.file}:${finding.line}`);
    }

    if (finding.file && isProtectedPath(finding.file, protectedPaths)) {
      score += 15;
      reasons.push(`Finding touches protected path ${finding.file}`);
    }
  }

  if (findings.length > 0 && !diffContext.hasTestChanges) {
    score += 10;
    reasons.push('No test changes were detected in this PR');
  }

  if (diffContext.hasCiChanges) {
    score += 12;
    reasons.push('CI/CD workflow files changed');
  }

  if (diffContext.hasDependencyChanges) {
    score += 8;
    reasons.push('Dependency manifest or lockfile changed');
  }

  if (findings.length === 0) {
    if (options.scope === 'pr' && options.totalFindingCount > 0) {
      reasons.push('No PR-relevant scanner findings were found in changed files');
    } else {
      reasons.push('No scanner findings were loaded');
    }
  }

  const level = riskLevel(score, findings);
  const decision = level === 'critical' || level === 'high'
    ? 'block'
    : level === 'medium'
      ? 'warn'
      : 'allow';

  return {
    score,
    level,
    decision,
    reasons: [...new Set(reasons)]
  };
}

function shouldFail(level, failOn = 'never') {
  if (!failOn || failOn === 'never') return false;
  if (level === 'unknown') return failOn === 'unknown';
  if (failOn === 'unknown') return false;
  if (!RISK_ORDER.includes(failOn)) {
    throw new Error(`Invalid fail-on threshold: ${failOn}`);
  }
  if (!RISK_ORDER.includes(level)) {
    throw new Error(`Invalid risk level: ${level}`);
  }
  return RISK_ORDER.indexOf(level) >= RISK_ORDER.indexOf(failOn);
}

module.exports = {
  RISK_ORDER,
  scoreRisk,
  shouldFail,
  titleCase,
  unknownRisk
};
