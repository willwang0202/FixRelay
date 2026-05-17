const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FIXRELAY_HOOK_MARKER,
  HOOK_SCRIPT_TEMPLATE,
  getStagedDiff,
  getStagedFiles,
  getHooksDir,
  removeHook,
  runHookCheck,
  writeHook
} = require('../src/hook.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-hook-'));
  const gitDir = path.join(tmp, '.git');
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  return { repoPath: tmp, hooksDir };
}

// Spawn stub that always returns core.hooksPath as the .git/hooks fallback
function makeSpawnNoHooksPath() {
  return () => ({ status: 1, stdout: '', stderr: '' });
}

// Fake fs adapter backed by an in-memory map
function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p, _enc) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, content) => { files.set(p, content); },
    mkdirSync: (p, _opts) => { dirs.add(p); },
    unlinkSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: 'ENOENT' });
      files.delete(p);
    },
    _files: files
  };
}

// ─── HOOK_SCRIPT_TEMPLATE ────────────────────────────────────────────────────

test('HOOK_SCRIPT_TEMPLATE contains the FixRelay marker', () => {
  assert.ok(HOOK_SCRIPT_TEMPLATE.includes(FIXRELAY_HOOK_MARKER));
});

test('HOOK_SCRIPT_TEMPLATE is a valid sh shebang script', () => {
  assert.ok(HOOK_SCRIPT_TEMPLATE.startsWith('#!/bin/sh'));
});

test('HOOK_SCRIPT_TEMPLATE contains __FAIL_ON__ placeholder', () => {
  assert.ok(HOOK_SCRIPT_TEMPLATE.includes('__FAIL_ON__'));
});

// ─── getHooksDir ─────────────────────────────────────────────────────────────

test('getHooksDir falls back to .git/hooks when core.hooksPath is unset', () => {
  const { repoPath } = makeTmpRepo();
  const _spawn = makeSpawnNoHooksPath();
  const dir = getHooksDir(repoPath, _spawn);
  assert.equal(dir, path.join(repoPath, '.git', 'hooks'));
});

test('getHooksDir returns custom hooksPath when core.hooksPath is set', () => {
  const { repoPath } = makeTmpRepo();
  const custom = path.join(repoPath, '.githooks');
  const _spawn = (_cmd, _args, _opts) => ({ status: 0, stdout: `${custom}\n`, stderr: '' });
  const dir = getHooksDir(repoPath, _spawn);
  assert.equal(dir, custom);
});

test('getHooksDir resolves relative core.hooksPath against repo root', () => {
  const { repoPath } = makeTmpRepo();
  const _spawn = () => ({ status: 0, stdout: '.githooks\n', stderr: '' });
  const dir = getHooksDir(repoPath, _spawn);
  assert.equal(dir, path.resolve(repoPath, '.githooks'));
});

// ─── writeHook ───────────────────────────────────────────────────────────────

test('writeHook creates hook file with marker and fail-on substituted', () => {
  const { repoPath, hooksDir } = makeTmpRepo();
  const { hookPath } = writeHook({ repoPath, failOn: 'critical', _spawn: makeSpawnNoHooksPath() });

  assert.ok(fs.existsSync(hookPath));
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes(FIXRELAY_HOOK_MARKER));
  assert.ok(content.includes('--fail-on critical'));
  assert.ok(!content.includes('__FAIL_ON__'), 'placeholder must be replaced');
  assert.equal(hookPath, path.join(hooksDir, 'pre-commit'));
});

test('writeHook creates hook file with default fail-on high', () => {
  const { repoPath } = makeTmpRepo();
  writeHook({ repoPath, _spawn: makeSpawnNoHooksPath() });
  const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-commit');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('--fail-on high'));
});

test('writeHook refuses to overwrite non-FixRelay hook without force', () => {
  const { repoPath, hooksDir } = makeTmpRepo();
  const hookPath = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho "my custom hook"\n');

  assert.throws(
    () => writeHook({ repoPath, _spawn: makeSpawnNoHooksPath() }),
    /not managed by FixRelay/
  );
  // Existing hook must be untouched
  assert.ok(fs.readFileSync(hookPath, 'utf8').includes('my custom hook'));
});

test('writeHook overwrites non-FixRelay hook when force: true', () => {
  const { repoPath, hooksDir } = makeTmpRepo();
  const hookPath = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho "my custom hook"\n');

  writeHook({ repoPath, force: true, _spawn: makeSpawnNoHooksPath() });

  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes(FIXRELAY_HOOK_MARKER));
});

test('writeHook happily re-installs over an existing FixRelay hook', () => {
  const { repoPath } = makeTmpRepo();
  writeHook({ repoPath, failOn: 'medium', _spawn: makeSpawnNoHooksPath() });
  writeHook({ repoPath, failOn: 'critical', _spawn: makeSpawnNoHooksPath() }); // no error

  const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-commit');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('--fail-on critical'));
});

test('writeHook throws when repoPath is missing', () => {
  assert.throws(() => writeHook({}), /repoPath is required/);
});

test('writeHook uses fake fs and spawn via injection', () => {
  const fakeFs = makeFakeFs();
  const hookPath = '/repo/.git/hooks/pre-commit';
  const _spawn = (_cmd, args) => {
    // git config core.hooksPath → not set
    if (args.includes('core.hooksPath')) return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  writeHook({ repoPath: '/repo', failOn: 'high', _spawn, _fs: fakeFs });

  assert.ok(fakeFs._files.has(hookPath));
  const content = fakeFs._files.get(hookPath);
  assert.ok(content.includes(FIXRELAY_HOOK_MARKER));
});

// ─── removeHook ──────────────────────────────────────────────────────────────

test('removeHook removes an existing FixRelay hook', () => {
  const { repoPath } = makeTmpRepo();
  writeHook({ repoPath, _spawn: makeSpawnNoHooksPath() });
  const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hookPath));

  removeHook({ repoPath, _spawn: makeSpawnNoHooksPath() });
  assert.ok(!fs.existsSync(hookPath));
});

test('removeHook throws when no hook file exists', () => {
  const { repoPath } = makeTmpRepo();
  assert.throws(() => removeHook({ repoPath, _spawn: makeSpawnNoHooksPath() }), /No pre-commit hook/);
});

test('removeHook refuses to remove a non-FixRelay hook', () => {
  const { repoPath, hooksDir } = makeTmpRepo();
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "husky"\n');
  assert.throws(
    () => removeHook({ repoPath, _spawn: makeSpawnNoHooksPath() }),
    /not managed by FixRelay/
  );
  // Hook file must still exist
  assert.ok(fs.existsSync(path.join(hooksDir, 'pre-commit')));
});

test('removeHook throws when repoPath is missing', () => {
  assert.throws(() => removeHook({}), /repoPath is required/);
});

// ─── getStagedFiles ──────────────────────────────────────────────────────────

test('getStagedFiles parses git output into array', () => {
  const _spawn = () => ({
    status: 0,
    stdout: 'src/auth.js\nlib/utils.js\n',
    stderr: ''
  });
  const files = getStagedFiles({ _spawn });
  assert.deepEqual(files, ['src/auth.js', 'lib/utils.js']);
});

test('getStagedFiles returns empty array when git fails', () => {
  const _spawn = () => ({ status: 1, stdout: '', stderr: 'not a git repo' });
  const files = getStagedFiles({ _spawn });
  assert.deepEqual(files, []);
});

test('getStagedFiles filters empty lines', () => {
  const _spawn = () => ({ status: 0, stdout: 'a.js\n\nb.js\n\n', stderr: '' });
  const files = getStagedFiles({ _spawn });
  assert.deepEqual(files, ['a.js', 'b.js']);
});

// ─── getStagedDiff ───────────────────────────────────────────────────────────

test('getStagedDiff returns stdout from git diff --cached', () => {
  const diffText = 'diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n';
  const _spawn = () => ({ status: 0, stdout: diffText, stderr: '' });
  assert.equal(getStagedDiff({ _spawn }), diffText);
});

test('getStagedDiff returns empty string when git fails', () => {
  const _spawn = () => ({ status: 128, stdout: '', stderr: 'fatal' });
  assert.equal(getStagedDiff({ _spawn }), '');
});

// ─── runHookCheck ─────────────────────────────────────────────────────────────

function makeSarifContent(severity = 'high') {
  return JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Semgrep', rules: [{ id: 'rule.x', shortDescription: { text: 'Test finding' }, properties: { 'security-severity': severity === 'critical' ? '9.5' : severity === 'high' ? '7.5' : severity === 'medium' ? '5.0' : '2.0' } }] } },
      results: [{
        ruleId: 'rule.x',
        message: { text: 'Security issue' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/auth.js' }, region: { startLine: 5 } } }]
      }]
    }]
  });
}

test('runHookCheck exits 0 when Semgrep is not available', () => {
  const _spawn = () => ({ status: 1, stdout: '', stderr: 'ENOENT' });
  const result = runHookCheck({ _spawn });
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /not installed/);
});

test('runHookCheck exits 0 when no staged files', () => {
  let callCount = 0;
  const _spawn = (cmd, args) => {
    // semgrep --version → success (available)
    if (cmd === 'semgrep' && args.includes('--version')) return { status: 0, stdout: '1.0.0', stderr: '' };
    // git diff --cached --name-only → empty
    if (cmd === 'git' && args.includes('--name-only')) return { status: 0, stdout: '', stderr: '' };
    callCount++;
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = runHookCheck({ _spawn });
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /No staged files/);
});

test('runHookCheck exits 1 when high finding meets fail-on high threshold', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-hookcheck-'));
  const sarifPath = path.join(tmp, 'staged.sarif');
  fs.writeFileSync(sarifPath, makeSarifContent('high'));

  const _spawn = (cmd, args) => {
    if (cmd === 'semgrep' && args.includes('--version')) return { status: 0, stdout: '1.0.0', stderr: '' };
    if (cmd === 'git' && args.includes('--name-only')) return { status: 0, stdout: 'src/auth.js\n', stderr: '' };
    if (cmd === 'git' && args.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'semgrep' && args.includes('scan')) {
      fs.writeFileSync(args[args.indexOf('--output') + 1], makeSarifContent('high'));
      return { status: 1, stdout: '', stderr: '' }; // exit 1 = findings present
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runHookCheck({ failOn: 'high', _spawn });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /blocked/i);
});

test('runHookCheck exits 0 when medium finding is below fail-on high threshold', () => {
  const _spawn = (cmd, args) => {
    if (cmd === 'semgrep' && args.includes('--version')) return { status: 0, stdout: '1.0.0', stderr: '' };
    if (cmd === 'git' && args.includes('--name-only')) return { status: 0, stdout: 'src/util.js\n', stderr: '' };
    if (cmd === 'git' && args.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'semgrep' && args.includes('scan')) {
      const sarifPath = args[args.indexOf('--output') + 1];
      fs.writeFileSync(sarifPath, makeSarifContent('medium'));
      return { status: 1, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runHookCheck({ failOn: 'high', _spawn });
  assert.equal(result.exitCode, 0);
  // Score is low/medium — message says risk is below the threshold
  assert.match(result.message, /below high threshold/i);
});

test('runHookCheck exits 0 when Semgrep scan fails (fail-open)', () => {
  const _spawn = (cmd, args) => {
    if (cmd === 'semgrep' && args.includes('--version')) return { status: 0, stdout: '1.0.0', stderr: '' };
    if (cmd === 'git' && args.includes('--name-only')) return { status: 0, stdout: 'src/auth.js\n', stderr: '' };
    if (cmd === 'semgrep' && args.includes('scan')) return { status: 2, stdout: '', stderr: 'config error' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runHookCheck({ _spawn });
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /failed/);
});

test('runHookCheck exits 1 when critical finding meets fail-on critical threshold', () => {
  const _spawn = (cmd, args) => {
    if (cmd === 'semgrep' && args.includes('--version')) return { status: 0, stdout: '1.0.0', stderr: '' };
    if (cmd === 'git' && args.includes('--name-only')) return { status: 0, stdout: 'src/auth.js\n', stderr: '' };
    if (cmd === 'git' && args.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'semgrep' && args.includes('scan')) {
      const sarifPath = args[args.indexOf('--output') + 1];
      fs.writeFileSync(sarifPath, makeSarifContent('critical'));
      return { status: 1, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runHookCheck({ failOn: 'critical', _spawn });
  assert.equal(result.exitCode, 1);
});

test('runHookCheck exits 0 when no findings', () => {
  const emptySarif = JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'Semgrep', rules: [] } }, results: [] }]
  });

  const _spawn = (cmd, args) => {
    if (cmd === 'semgrep' && args.includes('--version')) return { status: 0, stdout: '1.0.0', stderr: '' };
    if (cmd === 'git' && args.includes('--name-only')) return { status: 0, stdout: 'src/clean.js\n', stderr: '' };
    if (cmd === 'git' && args.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'semgrep' && args.includes('scan')) {
      const sarifPath = args[args.indexOf('--output') + 1];
      fs.writeFileSync(sarifPath, emptySarif);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runHookCheck({ failOn: 'high', _spawn });
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /No findings/);
});
