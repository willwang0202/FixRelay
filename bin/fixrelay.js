#!/usr/bin/env node

const cp = require('node:child_process');
const fs = require('node:fs');
const { runFixRelay } = require('../src/index.js');

function usage() {
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
    '  --fail-on <level>       low, medium, high, critical, or never.',
    '  --scope <scope>         pr or entire-repo. Defaults to pr.',
    '  --pr-title <text>       Pull request title for report context.',
    '  --pr-body <text>        Pull request body for report context.',
    '  --protected-path <path> Protected path prefix. Can be repeated.',
    '  --package-manager <pm>  npm, pnpm, yarn, python, go, or generic.',
    '  --post-comment         Post report with gh pr comment when available.',
    '  --help                 Show this help text.'
  ].join('\n');
}

function readOption(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    return { help: true };
  }
  if (command !== 'generate') {
    throw new Error(`Unknown command: ${command}`);
  }

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
    } else if (arg === '--post-comment') {
      options.postComment = true;
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

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }

    const summary = runFixRelay(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (options.postComment) {
      postCommentWithGh(summary.artifacts.report);
    }

    if (summary.shouldFail) {
      process.stderr.write(`FixRelay blocked merge: ${summary.risk.level} risk meets --fail-on ${options.failOn}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`FixRelay error: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  parseArgs,
  postCommentWithGh,
  usage
};
