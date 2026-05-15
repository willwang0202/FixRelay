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
  const llmReview = boolInput(getInput(env, 'llm-review'), false);
  const options = {
    runSemgrep: boolInput(getInput(env, 'run-semgrep'), true),
    semgrepConfig: getInput(env, 'semgrep-config') || 'auto',
    sarifPaths: splitList(getInput(env, 'sarif')),
    scannerJsonPaths: splitList(getInput(env, 'scanner-json')),
    diff: getInput(env, 'diff') || undefined,
    diffFile: getInput(env, 'diff-file') || undefined,
    outDir: getInput(env, 'out-dir', 'fixrelay-out'),
    failOn: getInput(env, 'fail-on', 'never'),
    postComment: boolInput(getInput(env, 'post-comment'), true),
    scope: getInput(env, 'scope') || undefined,
    packageManager: getInput(env, 'package-manager') || undefined,
    llmReview,
    llmEndpoint: getInput(env, 'llm-endpoint') || undefined,
    llmModel: getInput(env, 'llm-model') || undefined,
    llmTimeoutMs: Number(getInput(env, 'llm-timeout-ms') || 20000),
    llmMaxSnippetLines: Number(getInput(env, 'llm-max-snippet-lines') || 40)
  };

  if (llmReview && env.LLM_API_KEY) {
    options.llmApiKey = env.LLM_API_KEY;
  }

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
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          reject(new Error(`GitHub API ${method} ${urlPath} returned non-JSON response (${response.statusCode})`));
          return;
        }
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

const MAX_COMMENT_PAGES = 50;

async function findExistingComment({ token, repository, issueNumber, apiUrl, request }) {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await request({
      method: 'GET',
      urlPath: `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token,
      apiUrl
    });
    if (!comments || comments.length === 0) return undefined;
    const found = findExistingFixRelayComment(comments);
    if (found) return found;
    if (comments.length < 100) return undefined;
  }
  return undefined;
}

async function upsertPullRequestComment({
  token,
  repository,
  issueNumber,
  report,
  apiUrl,
  request = githubRequest
}) {
  const existing = await findExistingComment({ token, repository, issueNumber, apiUrl, request });
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
  try {
    return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    process.stderr.write('FixRelay warning: could not parse GITHUB_EVENT_PATH; proceeding without event context.\n');
    return {};
  }
}

function writeOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

async function runAction(env = process.env, options = {}) {
  const inputs = parseActionInputs(env);
  const event = readEvent(env);
  const pullRequest = event.pull_request;

  if (!inputs.diff && pullRequest?.base?.ref) {
    inputs.diff = `origin/${pullRequest.base.ref}...HEAD`;
  }

  inputs.prTitle = pullRequest?.title || event.issue?.title || '';
  inputs.prBody = pullRequest?.body || event.issue?.body || '';

  const summary = await runFixRelay(inputs);
  writeOutput('risk', summary.risk.level, env);
  writeOutput('decision', summary.decision, env);
  writeOutput('report', path.resolve(summary.artifacts.report), env);
  writeOutput('tasks', path.resolve(summary.artifacts.tasks), env);
  writeOutput('findings', path.resolve(summary.artifacts.findings), env);
  writeOutput('prompt', path.resolve(summary.artifacts.prompt), env);
  if (summary.artifacts.llmReview) {
    writeOutput('llm-review-artifact', path.resolve(summary.artifacts.llmReview), env);
  }

  if (inputs.postComment && pullRequest?.number) {
    const token = env.GITHUB_TOKEN;
    const repository = env.GITHUB_REPOSITORY;
    if (!token || !repository) {
      throw new Error('post-comment requires GITHUB_TOKEN and GITHUB_REPOSITORY');
    }
    const report = fs.readFileSync(summary.artifacts.report, 'utf8');
    try {
      await upsertPullRequestComment({
        token,
        repository,
        issueNumber: pullRequest.number,
        report,
        apiUrl: env.GITHUB_API_URL,
        request: options.request || githubRequest
      });
    } catch (error) {
      process.stderr.write(`FixRelay warning: could not post PR comment: ${error.message}\n`);
    }
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
