const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINES = 40;

function isSafePath(filePath, cwd) {
  if (path.isAbsolute(filePath)) return false;
  const resolved = path.resolve(cwd, filePath);
  const base = path.resolve(cwd);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

function readSnippet({ file, line, cwd = process.cwd(), maxLines = DEFAULT_MAX_LINES }) {
  if (!file) return { file, content: null, error: 'no-file' };
  if (!isSafePath(file, cwd)) return { file, content: null, error: 'unsafe-path' };

  const absPath = path.resolve(cwd, file);
  let raw;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return { file, content: null, error: 'file-too-large' };
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return { file, content: null, error: 'file-not-found' };
  }

  const allLines = raw.split('\n');
  const totalLines = allLines.length;
  const center = Math.max(1, Number(line) || 1);
  const half = Math.floor(maxLines / 2);
  const startLine = Math.max(1, center - half);
  const endLine = Math.min(totalLines, startLine + maxLines - 1);
  const truncated = startLine > 1 || endLine < totalLines;

  return {
    file,
    startLine,
    endLine,
    content: allLines.slice(startLine - 1, endLine).join('\n'),
    truncated
  };
}

module.exports = { readSnippet };
