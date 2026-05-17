#!/usr/bin/env node

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { runFixRelay } = require('../src/index.js');
const { compareFindings, loadOutcome, severityGate } = require('../src/outcome.js');
const { writeHook, removeHook, runHookCheck } = require('../src/hook.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readOption(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

// ─── generate ─────────────────────────────────────────────────────────────────

function generateUsage() {
  return [
    'Usage:',
    '  fixrelay generate --sarif <file> [--diff <range>|--diff-file <file>] [options]',
    '',
    'Options:',
    '  --sarif <file>          SARIF scanner output. Can be repeated.',
    '  --scanner-json <file>   Generic scanner JSON output. Can be repeated.',
    '  --diff <range>          Git diff range, such as origin/main...HEAD.',
    '  --diff-file <file>      Unified diff file.',
    '  --out-dir <dir>         Artifact directory. Defaults to fixrelay-out.',
    '  --fail-on <level>       low, medium, high, critical, unknown, or never.',
    '  --scope <scope>         pr or entire-repo. Defaults to pr.',
    '  --pr-title <text>       Pull request title for report context.',
    '  --pr-body <text>        Pull request body for report context.',
    '  --protected-path <path> Protected path prefix. Can be repeated.',
    '  --package-manager <pm>  npm, pnpm, yarn, python, go, or generic.',
    '  --no-semgrep            Skip automatic Semgrep scan even when no --sarif is provided.',
    '  --semgrep-config <cfg>  Semgrep --config value. Defaults to auto.',
    '  --post-comment          Post report with gh pr comment when available.',
    '  --llm-review            Enable LLM triage pass (requires LLM_API_KEY env var).',
    '  --llm-endpoint <url>    OpenAI-compatible endpoint base URL.',
    '  --llm-model <name>      Model name to pass to the endpoint.',
    '  --llm-timeout-ms <ms>   LLM call timeout in milliseconds. Defaults to 20000.',
    '  --llm-max-snippet-lines <n>  Max code lines per finding. Defaults to 40.',
    '  --help                  Show this help text.'
  ].join('\n');
}

function parseGenerateArgs(args) {
  const options = {
    sarifPaths: [],
    scannerJsonPaths: [],
    protectedPaths: [],
    failOn: 'never'
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--sarif') {
      options.sarifPaths.push(readOption(args, index, arg));
      index += 1;
    } else if (arg === '--scanner-json') {
      options.scannerJsonPaths.push(readOption(args, index, arg));
      index += 1;
    } else if (arg === '--diff') {
      options.diff = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--diff-file') {
      options.diffFile = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--fail-on') {
      options.failOn = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--scope') {
      options.scope = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--pr-title') {
      options.prTitle = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--pr-body') {
      options.prBody = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--protected-path') {
      options.protectedPaths.push(readOption(args, index, arg));
      index += 1;
    } else if (arg === '--package-manager') {
      options.packageManager = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--no-semgrep') {
      options.runSemgrep = false;
    } else if (arg === '--semgrep-config') {
      options.semgrepConfig = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--post-comment') {
      options.postComment = true;
    } else if (arg === '--llm-review') {
      options.llmReview = true;
    } else if (arg === '--llm-endpoint') {
      options.llmEndpoint = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--llm-model') {
      options.llmModel = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--llm-timeout-ms') {
      options.llmTimeoutMs = Number(readOption(args, index, arg));
      index += 1;
    } else if (arg === '--llm-max-snippet-lines') {
      options.llmMaxSnippetLines = Number(readOption(args, index, arg));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.protectedPaths.length === 0) delete options.protectedPaths;
  return options;
}

function postCommentWithGh(reportPath) {
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    throw new Error('--post-comment requires GITHUB_TOKEN or GH_TOKEN for gh');
  }
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report does not exist: ${reportPath}`);
  }
  cp.execFileSync('gh', ['pr', 'comment', '--body-file', reportPath], {
    stdio: 'inherit'
  });
}

async function runGenerate(args) {
  const options = parseGenerateArgs(args);

  if (options.help) {
    process.stdout.write(`${generateUsage()}\n`);
    return 0;
  }

  if (options.llmReview && process.env.LLM_API_KEY) {
    options.llmApiKey = process.env.LLM_API_KEY;
  }

  const summary = await runFixRelay(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (options.postComment) {
    postCommentWithGh(summary.artifacts.report);
  }

  if (summary.shouldFail) {
    process.stderr.write(`FixRelay blocked merge: ${summary.risk.level} risk meets --fail-on ${options.failOn}\n`);
    return 1;
  }
  return 0;
}

// ─── compare-outcome ──────────────────────────────────────────────────────────

function compareOutcomeUsage() {
  return [
    'Usage:',
    '  fixrelay compare-outcome --previous <summary.json> --current <summary.json> [options]',
    '',
    'Options:',
    '  --previous <path>           summary.json from the base run (before fix).',
    '  --current <path>            summary.json from the fix run (after fix).',
    '  --out-dir <dir>             Artifact directory for fix-outcome.json. Defaults to fixrelay-out.',
    '  --fail-on-new-severity <s>  Fail if new findings of this severity or higher appear.',
    '                              low, medium, high, critical, or never. Defaults to low.',
    '  --help                      Show this help text.'
  ].join('\n');
}

function parseCompareOutcomeArgs(args) {
  const options = { failOnNewSeverity: 'low' };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--previous') {
      options.previousSummaryPath = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--current') {
      options.currentSummaryPath = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--fail-on-new-severity') {
      options.failOnNewSeverity = readOption(args, index, arg);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function runCompareOutcome(args) {
  const options = parseCompareOutcomeArgs(args);

  if (options.help) {
    process.stdout.write(`${compareOutcomeUsage()}\n`);
    return 0;
  }

  if (!options.previousSummaryPath) {
    throw new Error('--previous is required');
  }
  if (!options.currentSummaryPath) {
    throw new Error('--current is required');
  }

  const result = loadOutcome({
    previousSummaryPath: options.previousSummaryPath,
    currentSummaryPath: options.currentSummaryPath,
    failOnNewSeverity: options.failOnNewSeverity
  });

  const outDir = options.outDir || 'fixrelay-out';
  fs.mkdirSync(outDir, { recursive: true });

  const outcomePath = path.join(outDir, 'fix-outcome.json');
  fs.writeFileSync(outcomePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({ ...result, outcomeFile: outcomePath }, null, 2)}\n`);

  if (result.gate.triggered) {
    process.stderr.write(
      `FixRelay: Regression detected — ${result.newCount} new finding${result.newCount === 1 ? '' : 's'} ` +
      `(${result.gate.triggeringSeverities.join(', ')}) appeared after the fix.\n`
    );
    return 1;
  }

  if (result.resolvedCount > 0) {
    process.stderr.write(
      `FixRelay: ${result.resolvedCount} finding${result.resolvedCount === 1 ? '' : 's'} resolved. ` +
      `${result.persistedCount} persisted. ${result.newCount} new.\n`
    );
  }

  return 0;
}

// ─── hook ─────────────────────────────────────────────────────────────────────

function hookUsage() {
  return [
    'Usage:',
    '  fixrelay hook install [--repo <path>] [--fail-on <level>] [--force]',
    '  fixrelay hook uninstall [--repo <path>]',
    '  fixrelay hook check [--fail-on <level>] [--semgrep-config <cfg>]',
    '',
    'Subcommands:',
    '  install    Install a FixRelay pre-commit hook. Defaults to blocking on high/critical.',
    '  uninstall  Remove the FixRelay pre-commit hook (only if installed by FixRelay).',
    '  check      Run the staged-diff security check (called by the hook script).',
    '',
    'Options for install:',
    '  --repo <path>       Path to git repo root. Defaults to current directory.',
    '  --fail-on <level>   low, medium, high, critical. Defaults to high.',
    '  --force             Overwrite an existing non-FixRelay pre-commit hook.',
    '',
    'Options for check:',
    '  --fail-on <level>       Threshold for blocking the commit. Defaults to high.',
    '  --semgrep-config <cfg>  Semgrep --config value. Defaults to auto.',
    '  --help                  Show this help text.'
  ].join('\n');
}

function parseHookArgs(args) {
  const action = args[0];
  if (!action || action === '--help' || action === '-h') {
    return { action: 'help' };
  }
  if (!['install', 'uninstall', 'check'].includes(action)) {
    throw new Error(`Unknown hook subcommand: ${action}. Use install, uninstall, or check.`);
  }

  const options = { action, failOn: 'high', repo: process.cwd() };
  const rest = args.slice(1);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--repo') {
      options.repo = readOption(rest, index, arg);
      index += 1;
    } else if (arg === '--fail-on') {
      options.failOn = readOption(rest, index, arg);
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--semgrep-config') {
      options.semgrepConfig = readOption(rest, index, arg);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown hook option: ${arg}`);
    }
  }

  return options;
}

async function runHook(args) {
  const options = parseHookArgs(args);

  if (options.action === 'help' || options.help) {
    process.stdout.write(`${hookUsage()}\n`);
    return 0;
  }

  if (options.action === 'install') {
    const { hookPath } = writeHook({
      repoPath: options.repo,
      failOn: options.failOn,
      force: options.force || false
    });
    process.stderr.write(`FixRelay: pre-commit hook installed at ${hookPath}\n`);
    process.stderr.write(`  Threshold: ${options.failOn}. Remove with: fixrelay hook uninstall\n`);
    return 0;
  }

  if (options.action === 'uninstall') {
    removeHook({ repoPath: options.repo });
    process.stderr.write(`FixRelay: pre-commit hook removed.\n`);
    return 0;
  }

  if (options.action === 'check') {
    const result = runHookCheck({
      cwd: process.cwd(),
      failOn: options.failOn,
      semgrepConfig: options.semgrepConfig || 'auto'
    });
    process.stderr.write(`${result.message}\n`);
    return result.exitCode;
  }

  throw new Error(`Unknown hook action: ${options.action}`);
}

// ─── top-level dispatch ───────────────────────────────────────────────────────

function topLevelUsage() {
  return [
    'Usage:',
    '  fixrelay <command> [options]',
    '',
    'Commands:',
    '  generate         Score PR merge risk and generate AI fix prompts.',
    '  compare-outcome  Compare two FixRelay runs to detect regressions.',
    '  hook             Manage the local pre-commit security gate.',
    '',
    'Run `fixrelay <command> --help` for command-specific options.'
  ].join('\n');
}

function dispatch(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'generate') return { command: 'generate', args: args.slice(1) };
  if (command === 'compare-outcome') return { command: 'compare-outcome', args: args.slice(1) };
  if (command === 'hook') return { command: 'hook', args: args.slice(1) };

  throw new Error(`Unknown command: ${command}. Run fixrelay --help for usage.`);
}

async function main() {
  try {
    const { command, args } = dispatch(process.argv);

    if (command === 'help') {
      process.stdout.write(`${topLevelUsage()}\n`);
      return 0;
    }

    if (command === 'generate') return await runGenerate(args);
    if (command === 'compare-outcome') return await runCompareOutcome(args);
    if (command === 'hook') return await runHook(args);

    throw new Error(`Unhandled command: ${command}`);
  } catch (error) {
    process.stderr.write(`FixRelay error: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

// Legacy alias — existing tests import parseArgs directly
const parseArgs = (argv) => {
  const args = argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (command !== 'generate') throw new Error(`Unknown command: ${command}`);
  return parseGenerateArgs(args);
};

module.exports = {
  dispatch,
  parseArgs,
  parseCompareOutcomeArgs,
  parseGenerateArgs,
  parseHookArgs,
  postCommentWithGh,
  topLevelUsage
};
