const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROTECTED_PATHS = [
  'auth/',
  'authentication/',
  'billing/',
  'payments/',
  'infra/',
  'infrastructure/',
  '.github/workflows/',
  'Dockerfile'
];

function normalizePath(value) {
  const stripped = String(value || '')
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^[ab]\//, '');
  return path.posix.normalize(stripped).replace(/^\.\//, '');
}

function isTestPath(file) {
  return /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file) ||
    /_test\.(go|py)$/i.test(file);
}

function isDependencyManifest(file) {
  return [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'requirements.txt',
    'poetry.lock',
    'pyproject.toml',
    'Gemfile',
    'Gemfile.lock',
    'go.mod',
    'go.sum',
    'Cargo.toml',
    'Cargo.lock'
  ].includes(file);
}

function isProtectedPath(file, protectedPaths = DEFAULT_PROTECTED_PATHS) {
  return protectedPaths.some((protectedPath) => {
    const normalized = normalizePath(protectedPath);
    return normalized.endsWith('/')
      ? file.startsWith(normalized)
      : file === normalized || file.startsWith(`${normalized}/`);
  });
}

function inferPackageManager(cwd = process.cwd()) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'package.json'))) return 'npm';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) return 'python';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go';
  return 'generic';
}

function likelyTestFile(file) {
  if (!file) return undefined;
  const ext = path.posix.extname(file);
  const base = file.slice(0, -ext.length);
  if (/\.[cm]?[jt]sx?$/.test(ext)) return `${base}.test${ext}`;
  if (ext === '.py') return `tests/test_${path.posix.basename(file)}`;
  if (ext === '.go') return `${base}_test.go`;
  return undefined;
}

module.exports = {
  DEFAULT_PROTECTED_PATHS,
  inferPackageManager,
  isDependencyManifest,
  isProtectedPath,
  isTestPath,
  likelyTestFile,
  normalizePath
};
