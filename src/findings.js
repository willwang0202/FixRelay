const { normalizePath } = require('./paths.js');

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(severity)) return severity;
  if (['error', 'major'].includes(severity)) return 'high';
  if (['warning', 'warn', 'minor'].includes(severity)) return 'medium';
  return 'low';
}

function severityFromSarif(result, rule) {
  const securitySeverity =
    result?.properties?.['security-severity'] ??
    rule?.properties?.['security-severity'];
  const numericSeverity = Number(securitySeverity);
  if (Number.isFinite(numericSeverity)) {
    if (numericSeverity >= 9) return 'critical';
    if (numericSeverity >= 7) return 'high';
    if (numericSeverity >= 4) return 'medium';
    return 'low';
  }

  const level = result?.level || rule?.defaultConfiguration?.level || 'note';
  if (level === 'error') return 'high';
  if (level === 'warning') return 'medium';
  return 'low';
}

function findingTitle(result, rule) {
  return (
    rule?.shortDescription?.text ||
    rule?.fullDescription?.text ||
    result?.ruleId ||
    'Security finding'
  );
}

function sarifMessage(result) {
  return result?.message?.text || result?.message?.markdown || 'Scanner finding';
}

function cweTags(rule) {
  const tags = rule?.properties?.tags || [];
  return tags.filter((tag) => /^cwe[-_]\d+/i.test(tag)).map((tag) => tag.toLowerCase());
}

function sarifRegion(physicalLocation) {
  const region = physicalLocation?.region || {};
  return {
    startLine: region.startLine || undefined,
    startColumn: region.startColumn || undefined,
    endLine: region.endLine || undefined,
    endColumn: region.endColumn || undefined
  };
}

function sarifFingerprint(result, scanner, ruleId, file, line) {
  const partialFingerprints = result?.partialFingerprints || {};
  return (
    partialFingerprints.primaryLocationLineHash ||
    partialFingerprints.primaryLocationStartColumnFingerprint ||
    Object.values(partialFingerprints)[0] ||
    `${scanner}:${ruleId}:${file || 'unknown'}:${line || 0}`
  );
}

function loadFindingsFromSarif(sarifInput, source = 'sarif') {
  const sarif =
    typeof sarifInput === 'string' ? JSON.parse(sarifInput) : sarifInput;
  const findings = [];

  for (const run of sarif?.runs || []) {
    const scanner = run?.tool?.driver?.name || run?.tool?.extensions?.[0]?.name || 'SARIF';
    const rules = new Map();
    for (const rule of run?.tool?.driver?.rules || []) {
      if (rule?.id) rules.set(rule.id, rule);
    }

    for (const result of run?.results || []) {
      const rule = rules.get(result?.ruleId) || {};
      const physicalLocation = result?.locations?.[0]?.physicalLocation || {};
      const file = normalizePath(physicalLocation?.artifactLocation?.uri);
      const region = sarifRegion(physicalLocation);
      const line = region.startLine;
      const ruleId = result?.ruleId || rule?.id || 'unknown-rule';

      findings.push({
        id: `${scanner}:${ruleId}:${file || 'unknown'}:${line || 0}`,
        scanner,
        source,
        ruleId,
        severity: severityFromSarif(result, rule),
        title: findingTitle(result, rule),
        message: sarifMessage(result),
        file,
        line,
        region,
        fingerprint: sarifFingerprint(result, scanner, ruleId, file, line),
        helpUri: rule?.helpUri,
        codeSnippet: physicalLocation?.region?.snippet?.text,
        cwe: cweTags(rule),
        confidence: result?.properties?.confidence,
        raw: result
      });
    }
  }

  return findings;
}

function loadFindingsFromScannerJson(jsonInput, source = 'scanner.json') {
  const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
  const items = Array.isArray(parsed) ? parsed : parsed.findings || parsed.results || [];
  return items.map((item, index) => {
    const severity = normalizeSeverity(item.severity || item.level || 'medium');
    const file = normalizePath(item.file || item.path || item.location?.file || '');
    const line = item.line || item.location?.line;
    const ruleId = item.ruleId || item.rule || item.id || 'unknown-rule';
    return {
      id: item.id || ruleId || `${source}:${index}`,
      scanner: item.scanner || parsed.scanner || 'JSON scanner',
      source,
      ruleId,
      severity,
      title: item.title || item.name || ruleId || 'Security finding',
      message: item.message || item.description || item.title || 'Scanner finding',
      file,
      line,
      region: {
        startLine: line || undefined,
        startColumn: item.column || item.location?.column,
        endLine: item.endLine || item.location?.endLine,
        endColumn: item.endColumn || item.location?.endColumn
      },
      fingerprint: item.fingerprint || `${source}:${ruleId}:${file || 'unknown'}:${line || 0}`,
      helpUri: item.helpUri || item.help_uri,
      codeSnippet: item.codeSnippet || item.code_snippet,
      cwe: item.cwe || [],
      confidence: item.confidence,
      raw: item
    };
  });
}

function serializeFinding(finding) {
  return {
    id: finding.id,
    scanner: finding.scanner,
    source: finding.source,
    rule_id: finding.ruleId,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    message: finding.message,
    file: finding.file,
    line: finding.line,
    region: finding.region,
    fingerprint: finding.fingerprint,
    help_uri: finding.helpUri,
    code_snippet: finding.codeSnippet,
    cwe: finding.cwe || [],
    is_in_diff: Boolean(finding.isInDiff),
    is_on_changed_line: Boolean(finding.isOnChangedLine),
    is_blocking: Boolean(finding.isBlocking)
  };
}

module.exports = {
  loadFindingsFromSarif,
  loadFindingsFromScannerJson,
  normalizeSeverity,
  serializeFinding
};
