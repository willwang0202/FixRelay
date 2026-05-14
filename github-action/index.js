const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { runFixRelay, shouldFail } = require('../src/index.js');

const FIXRELAY_COMMENT_MARKER = '<!-- fixrelay-comment:start -->';

function inputNameToEnv(name) {
  return `INPUT_${String(name).replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`;
}

function splitList(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolInput(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getInput(env, name, fallback = '') {
  return env[inputNameToEnv(name)] || fallback;
}

function parseActionInputs(env = process.env) {
  const protectedPaths = splitList(getInput(env, 'protected-paths'));
  const options = {
    sarifPaths: splitList(getInput(env, 'sarif')),
    scannerJsonPaths: splitList(getInput(env, 'scanner-json')),
    diff: getInput(env, 'diff') || undefined,
    diffFile: getInput(env, 'diff-file') || undefined,
    outDir: getInput(env, 'out-dir', 'fixrelay-out'),
    failOn: getInput(env, 'fail-on', 'never'),
    postComment: boolInput(getInput(env, 'post-comment'), true),
    packageManager: getInput(env, 'package-manager') || undefined
  };

  if (protectedPaths.length > 0) {
    options.protectedPaths = protectedPaths;
  }

  return options;
}

function riskMeetsFailOn(level, failOn) {
  return shouldFail(level, failOn);
}

function findExistingFixRelayComment(comments) {
  return comments.find((comment) => String(comment.body || '').includes(FIXRELAY_COMMENT_MARKER));
}

function githubRequest({ method, urlPath, token, body, apiUrl = 'https://api.github.com' }) {
  const url = new URL(urlPath, apiUrl);
  const payload = body ? JSON.stringify(body) : undefined;
  const options = {
    method,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fixrelay-action',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`
    }
  };

  if (payload) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        const parsed = data ? JSON.parse(data) : null;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`GitHub API ${method} ${urlPath} failed with ${response.statusCode}: ${data}`));
        }
      });
    });

    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function upsertPullRequestComment({
  token,
  repository,
  issueNumber,
  report,
  apiUrl,
  request = githubRequest
}) {
  const commentsPath = `/repos/${repository}/issues/${issueNumber}/comments?per_page=100`;
  const comments = await request({
    method: 'GET',
    urlPath: commentsPath,
    token,
    apiUrl
  });
  const existing = findExistingFixRelayComment(comments || []);
  if (existing) {
    return request({
      method: 'PATCH',
      urlPath: `/repos/${repository}/issues/comments/${existing.id}`,
      token,
      apiUrl,
      body: { body: report }
    });
  }
  return request({
    method: 'POST',
    urlPath: `/repos/${repository}/issues/${issueNumber}/comments`,
    token,
    apiUrl,
    body: { body: report }
  });
}

function readEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH || !fs.existsSync(env.GITHUB_EVENT_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
}

function writeOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

async function runAction(env = process.env) {
  const inputs = parseActionInputs(env);
  const event = readEvent(env);
  const pullRequest = event.pull_request;

  if (!inputs.diff && pullRequest?.base?.ref) {
    inputs.diff = `origin/${pullRequest.base.ref}...HEAD`;
  }

  inputs.prTitle = pullRequest?.title || event.issue?.title || '';
  inputs.prBody = pullRequest?.body || event.issue?.body || '';

  const summary = runFixRelay(inputs);
  writeOutput('risk', summary.risk.level, env);
  writeOutput('decision', summary.decision, env);
  writeOutput('report', path.resolve(summary.artifacts.report), env);
  writeOutput('tasks', path.resolve(summary.artifacts.tasks), env);
  writeOutput('findings', path.resolve(summary.artifacts.findings), env);
  writeOutput('prompt', path.resolve(summary.artifacts.prompt), env);

  if (inputs.postComment && pullRequest?.number) {
    const token = env.GITHUB_TOKEN;
    const repository = env.GITHUB_REPOSITORY;
    if (!token || !repository) {
      throw new Error('post-comment requires GITHUB_TOKEN and GITHUB_REPOSITORY');
    }
    const report = fs.readFileSync(summary.artifacts.report, 'utf8');
    await upsertPullRequestComment({
      token,
      repository,
      issueNumber: pullRequest.number,
      report,
      apiUrl: env.GITHUB_API_URL
    });
  }

  if (riskMeetsFailOn(summary.risk.level, inputs.failOn)) {
    throw new Error(`FixRelay blocked merge: ${summary.risk.level} risk meets fail-on ${inputs.failOn}`);
  }

  return summary;
}

if (require.main === module) {
  runAction().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FIXRELAY_COMMENT_MARKER,
  findExistingFixRelayComment,
  githubRequest,
  inputNameToEnv,
  parseActionInputs,
  riskMeetsFailOn,
  runAction,
  splitList,
  upsertPullRequestComment
};
