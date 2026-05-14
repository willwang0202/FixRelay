const { isDependencyManifest, isTestPath, normalizePath } = require('./paths.js');

function ensureLineSet(map, file) {
  if (!map.has(file)) map.set(file, new Set());
  return map.get(file);
}

function parseUnifiedDiff(diffText = '') {
  const changedFiles = new Set();
  const changedLinesByFile = new Map();
  let currentFile = '';
  let newLine = 0;

  for (const line of String(diffText).split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw !== '/dev/null') {
        currentFile = normalizePath(raw);
        changedFiles.add(currentFile);
        ensureLineSet(changedLinesByFile, currentFile);
      }
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }

    if (!currentFile || line.startsWith('diff --git') || line.startsWith('index ')) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      ensureLineSet(changedLinesByFile, currentFile).add(newLine);
      newLine += 1;
    } else if (line.startsWith(' ') || line === '') {
      newLine += 1;
    }
  }

  const hasTestChanges = [...changedFiles].some(isTestPath);
  const hasCiChanges = [...changedFiles].some((file) => file.startsWith('.github/workflows/'));
  const hasDependencyChanges = [...changedFiles].some(isDependencyManifest);

  return {
    changedFiles,
    changedLinesByFile,
    hasTestChanges,
    hasCiChanges,
    hasDependencyChanges
  };
}

function applyScannerFileFallback(diffContext, findings) {
  if (diffContext.changedFiles.size > 0) return diffContext;

  const changedFiles = new Set(diffContext.changedFiles);
  const changedLinesByFile = new Map(diffContext.changedLinesByFile);

  for (const finding of findings) {
    if (!finding.file) continue;
    changedFiles.add(finding.file);
    if (!changedLinesByFile.has(finding.file)) changedLinesByFile.set(finding.file, new Set());
  }

  return {
    ...diffContext,
    changedFiles,
    changedLinesByFile,
    hasTestChanges: [...changedFiles].some(isTestPath),
    hasCiChanges: [...changedFiles].some((file) => file.startsWith('.github/workflows/')),
    hasDependencyChanges: [...changedFiles].some(isDependencyManifest)
  };
}

function annotateFindings(findings, diffContext, risk) {
  return findings.map((finding) => {
    const isInDiff = Boolean(finding.file && diffContext.changedFiles?.has(finding.file));
    const isOnChangedLine = Boolean(
      finding.file &&
      finding.line &&
      diffContext.changedLinesByFile?.get(finding.file)?.has(finding.line)
    );
    const isBlocking = risk.decision === 'block' && (
      finding.severity === 'high' ||
      finding.severity === 'critical' ||
      isOnChangedLine ||
      isInDiff
    );
    return {
      ...finding,
      isInDiff,
      isOnChangedLine,
      isBlocking
    };
  });
}

module.exports = {
  annotateFindings,
  applyScannerFileFallback,
  parseUnifiedDiff
};
