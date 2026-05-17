const fs = require('node:fs');
const path = require('node:path');

const { RISK_ORDER } = require('./risk.js');

// Slim projection written to fix-outcome.json (not the full serialized finding)
function slimFinding(finding) {
  return {
    fingerprint: finding.fingerprint,
    ruleId: finding.rule_id || finding.ruleId,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    title: finding.title
  };
}

/**
 * Compare two normalized finding arrays by fingerprint.
 *
 * Returns an OutcomeSummary classifying every finding as:
 *   resolved  — in previous, absent from current
 *   persisted — in both (same fingerprint)
 *   new       — absent from previous, in current
 *
 * @param {object[]} previousFindings  Serialized findings (normalized-findings.json)
 * @param {object[]} currentFindings   Serialized findings (normalized-findings.json)
 * @returns {OutcomeSummary}
 */
function compareFindings(previousFindings, currentFindings) {
  if (!Array.isArray(previousFindings)) throw new Error('previousFindings must be an array');
  if (!Array.isArray(currentFindings)) throw new Error('currentFindings must be an array');

  // Build maps — first occurrence wins (dedupes within a run)
  const prevMap = new Map();
  for (const finding of previousFindings) {
    if (!finding.fingerprint) throw new Error(`Finding is missing fingerprint: ${JSON.stringify(finding)}`);
    if (!prevMap.has(finding.fingerprint)) prevMap.set(finding.fingerprint, finding);
  }

  const currMap = new Map();
  for (const finding of currentFindings) {
    if (!finding.fingerprint) throw new Error(`Finding is missing fingerprint: ${JSON.stringify(finding)}`);
    if (!currMap.has(finding.fingerprint)) currMap.set(finding.fingerprint, finding);
  }

  const resolved = [];
  const persisted = [];
  const newFindings = [];

  for (const [fp, finding] of prevMap) {
    if (currMap.has(fp)) {
      persisted.push(slimFinding(finding));
    } else {
      resolved.push(slimFinding(finding));
    }
  }

  for (const [fp, finding] of currMap) {
    if (!prevMap.has(fp)) {
      newFindings.push(slimFinding(finding));
    }
  }

  return {
    previousFindingCount: prevMap.size,
    currentFindingCount: currMap.size,
    resolvedCount: resolved.length,
    persistedCount: persisted.length,
    newCount: newFindings.length,
    resolved,
    persisted,
    new: newFindings
  };
}

/**
 * Determine whether the outcome triggers the regression gate.
 *
 * @param {OutcomeSummary} outcome
 * @param {{ failOnNewSeverity: string }} options  'never' | 'low' | 'medium' | 'high' | 'critical'
 * @returns {{ triggered: boolean, triggeringSeverities: string[] }}
 */
function severityGate(outcome, { failOnNewSeverity = 'low' } = {}) {
  if (!failOnNewSeverity || failOnNewSeverity === 'never') {
    return { triggered: false, triggeringSeverities: [] };
  }

  if (!RISK_ORDER.includes(failOnNewSeverity)) {
    throw new Error(`Invalid failOnNewSeverity: "${failOnNewSeverity}". Must be one of: ${RISK_ORDER.join(', ')}, never`);
  }

  const threshold = RISK_ORDER.indexOf(failOnNewSeverity);
  const triggering = [...new Set(
    outcome.new
      .filter((f) => RISK_ORDER.includes(f.severity) && RISK_ORDER.indexOf(f.severity) >= threshold)
      .map((f) => f.severity)
  )];

  return {
    triggered: triggering.length > 0,
    triggeringSeverities: triggering
  };
}

/**
 * Load two FixRelay summary.json files and compare their findings.
 *
 * Each summary.json has an `artifacts.findings` field pointing to
 * the normalized-findings.json file. Paths in the artifact map may be
 * absolute or relative to the directory containing the summary file.
 *
 * @param {{ previousSummaryPath, currentSummaryPath, failOnNewSeverity?, _readFile? }} opts
 * @returns {{ outcome: OutcomeSummary, gate: object, generatedAt: string }}
 */
function loadOutcome({ previousSummaryPath, currentSummaryPath, failOnNewSeverity = 'low', _readFile = null } = {}) {
  if (!previousSummaryPath) throw new Error('previousSummaryPath is required');
  if (!currentSummaryPath) throw new Error('currentSummaryPath is required');

  const readFile = _readFile || ((p) => fs.readFileSync(p, 'utf8'));

  function loadSummary(summaryPath) {
    let raw;
    try {
      raw = readFile(summaryPath);
    } catch (err) {
      throw new Error(`Cannot read summary file ${summaryPath}: ${err.message}`);
    }
    let summary;
    try {
      summary = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Cannot parse JSON from ${summaryPath}: ${err.message}`);
    }
    return summary;
  }

  function loadFindings(summaryPath, summary) {
    const findingsPath = summary?.artifacts?.findings;
    if (!findingsPath) throw new Error(`summary.json at ${summaryPath} has no artifacts.findings field`);

    // Resolve relative paths against the summary file's directory
    const resolved = path.isAbsolute(findingsPath)
      ? findingsPath
      : path.resolve(path.dirname(summaryPath), findingsPath);

    let raw;
    try {
      raw = readFile(resolved);
    } catch (err) {
      throw new Error(`Cannot read findings file ${resolved} (referenced by ${summaryPath}): ${err.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Cannot parse JSON from ${resolved}: ${err.message}`);
    }
  }

  const prevSummary = loadSummary(previousSummaryPath);
  const currSummary = loadSummary(currentSummaryPath);

  const previousFindings = loadFindings(previousSummaryPath, prevSummary);
  const currentFindings = loadFindings(currentSummaryPath, currSummary);

  const outcome = compareFindings(previousFindings, currentFindings);
  const gate = severityGate(outcome, { failOnNewSeverity });

  return {
    generatedAt: new Date().toISOString(),
    previousSummary: previousSummaryPath,
    currentSummary: currentSummaryPath,
    ...outcome,
    gate: {
      failOnNewSeverity,
      ...gate
    }
  };
}

module.exports = {
  compareFindings,
  loadOutcome,
  severityGate
};
