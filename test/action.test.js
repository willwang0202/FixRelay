const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FIXRELAY_COMMENT_MARKER,
  findExistingFixRelayComment,
  inputNameToEnv,
  parseActionInputs,
  riskMeetsFailOn,
  runAction,
  upsertPullRequestComment
} = require('../github-action/index.js');

test('finds existing FixRelay PR comment by stable marker', () => {
  const comments = [
    { id: 1, body: 'ordinary comment' },
    { id: 2, body: `${FIXRELAY_COMMENT_MARKER}\n# Merge Risk: High` }
  ];

  assert.equal(findExistingFixRelayComment(comments).id, 2);
});

test('converts action input names to GitHub environment keys', () => {
  assert.equal(inputNameToEnv('fail-on'), 'INPUT_FAIL_ON');
  assert.equal(inputNameToEnv('post-comment'), 'INPUT_POST_COMMENT');
});

test('parses action inputs from environment with repeated path lists', () => {
  const env = {
    INPUT_SARIF: 'semgrep.sarif\ncodeql.sarif',
    INPUT_SCANNER_JSON: 'scanner.json',
    INPUT_DIFF: 'origin/main...HEAD',
    INPUT_OUT_DIR: 'relay-out',
    INPUT_FAIL_ON: 'high',
    INPUT_POST_COMMENT: 'false',
    INPUT_SCOPE: 'entire-repo',
    INPUT_PROTECTED_PATHS: 'auth/\nbilling/'
  };

  const inputs = parseActionInputs(env);

  assert.deepEqual(inputs.sarifPaths, ['semgrep.sarif', 'codeql.sarif']);
  assert.deepEqual(inputs.scannerJsonPaths, ['scanner.json']);
  assert.deepEqual(inputs.protectedPaths, ['auth/', 'billing/']);
  assert.equal(inputs.diff, 'origin/main...HEAD');
  assert.equal(inputs.outDir, 'relay-out');
  assert.equal(inputs.failOn, 'high');
  assert.equal(inputs.postComment, false);
  assert.equal(inputs.scope, 'entire-repo');
});

test('evaluates fail-on threshold for action wrapper', () => {
  assert.equal(riskMeetsFailOn('high', 'medium'), true);
  assert.equal(riskMeetsFailOn('medium', 'high'), false);
  assert.equal(riskMeetsFailOn('critical', 'never'), false);
  assert.throws(
    () => riskMeetsFailOn('medium', 'severe'),
    /Invalid fail-on threshold/
  );
});

test('upserts PR comment by updating existing FixRelay marker comment', async () => {
  const calls = [];
  const request = async (call) => {
    calls.push(call);
    if (call.method === 'GET') {
      return [
        { id: 10, body: 'ordinary comment' },
        { id: 20, body: `${FIXRELAY_COMMENT_MARKER}\nold report` }
      ];
    }
    return { id: 20, body: call.body.body };
  };

  await upsertPullRequestComment({
    token: 'token',
    repository: 'owner/repo',
    issueNumber: 5,
    report: `${FIXRELAY_COMMENT_MARKER}\nnew report`,
    request
  });

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].urlPath, '/repos/owner/repo/issues/comments/20');
});

test('upserts PR comment by creating one when no marker exists', async () => {
  const calls = [];
  const request = async (call) => {
    calls.push(call);
    if (call.method === 'GET') return [{ id: 10, body: 'ordinary comment' }];
    return { id: 30, body: call.body.body };
  };

  await upsertPullRequestComment({
    token: 'token',
    repository: 'owner/repo',
    issueNumber: 5,
    report: `${FIXRELAY_COMMENT_MARKER}\nnew report`,
    request
  });

  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].urlPath, '/repos/owner/repo/issues/5/comments');
});

test('paginates PR comments to find existing FixRelay marker beyond first page', async () => {
  const calls = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'ordinary' }));
  const page2 = [{ id: 200, body: `${FIXRELAY_COMMENT_MARKER}\nold report` }];

  const request = async (call) => {
    calls.push(call);
    if (call.method === 'GET') {
      return call.urlPath.includes('page=2') ? page2 : page1;
    }
    return { id: 200, body: call.body.body };
  };

  await upsertPullRequestComment({
    token: 'token',
    repository: 'owner/repo',
    issueNumber: 5,
    report: `${FIXRELAY_COMMENT_MARKER}\nnew report`,
    request
  });

  const getCalls = calls.filter((c) => c.method === 'GET');
  assert.equal(getCalls.length, 2);
  assert.ok(getCalls[0].urlPath.includes('page=1'));
  assert.ok(getCalls[1].urlPath.includes('page=2'));
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.equal(calls.at(-1).urlPath, '/repos/owner/repo/issues/comments/200');
});

test('runAction writes all artifact outputs when comment posting is disabled', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-action-outputs-'));
  const sarifPath = path.join(tmp, 'semgrep.sarif');
  const diffPath = path.join(tmp, 'pr.diff');
  const outDir = path.join(tmp, 'out');
  const outputPath = path.join(tmp, 'github-output');
  const eventPath = path.join(tmp, 'event.json');

  fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Semgrep',
            rules: [
              {
                id: 'auth.token.exposure',
                shortDescription: { text: 'Token exposure' },
                properties: { 'security-severity': '8.1', tags: ['cwe-200'] }
              }
            ]
          }
        },
        results: [
          {
            ruleId: 'auth.token.exposure',
            message: { text: 'Reset token is exposed in a response.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'auth/reset.js' },
                  region: { startLine: 8 }
                }
              }
            ]
          }
        ]
      }
    ]
  }), 'utf8');
  fs.writeFileSync(diffPath, [
    'diff --git a/auth/reset.js b/auth/reset.js',
    '--- a/auth/reset.js',
    '+++ b/auth/reset.js',
    '@@ -7,0 +8,1 @@',
    '+res.json({ token });',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 5,
      title: 'Auth reset PR',
      body: '',
      base: { ref: 'main' }
    }
  }), 'utf8');

  await runAction({
    INPUT_SARIF: sarifPath,
    INPUT_DIFF_FILE: diffPath,
    INPUT_OUT_DIR: outDir,
    INPUT_FAIL_ON: 'never',
    INPUT_POST_COMMENT: 'false',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath
  });

  const output = fs.readFileSync(outputPath, 'utf8');
  assert.match(output, /^risk=high$/m);
  assert.match(output, /^decision=block$/m);
  assert.match(output, /^report=.*merge-risk-report\.md$/m);
  assert.match(output, /^tasks=.*agent-fix-tasks\.json$/m);
  assert.match(output, /^findings=.*normalized-findings\.json$/m);
  assert.match(output, /^prompt=.*prompt\.md$/m);
});

test('runAction continues when PR comment posting is forbidden', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-action-comment-'));
  const sarifPath = path.join(tmp, 'empty.sarif');
  const outDir = path.join(tmp, 'out');
  const outputPath = path.join(tmp, 'github-output');
  const eventPath = path.join(tmp, 'event.json');

  fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Semgrep', rules: [] } },
        results: []
      }
    ]
  }), 'utf8');
  fs.writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 5,
      title: 'Empty PR',
      body: '',
      base: { ref: 'main' }
    }
  }), 'utf8');

  const summary = await runAction({
    INPUT_SARIF: sarifPath,
    INPUT_OUT_DIR: outDir,
    INPUT_FAIL_ON: 'high',
    INPUT_POST_COMMENT: 'true',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_TOKEN: 'token',
    GITHUB_REPOSITORY: 'owner/repo'
  }, {
    request: async (call) => {
      if (call.method === 'GET') return [];
      throw new Error('GitHub API POST failed with 403: Resource not accessible by integration');
    }
  });

  assert.equal(summary.risk.level, 'low');
  assert.equal(summary.shouldFail, false);
  const output = fs.readFileSync(outputPath, 'utf8');
  assert.match(output, /^risk=low$/m);
});
