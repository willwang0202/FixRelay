const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { downgradeRisk, stepDown, decisionFor } = require('../src/llm/downgrade.js');
const { parseLlmReview } = require('../src/llm/parser.js');
const { readSnippet } = require('../src/llm/snippet.js');
const { buildReviewMessages } = require('../src/llm/prompt.js');
const { runLlmReview, summarizeVerdicts } = require('../src/llm/review.js');
const { callChatCompletion } = require('../src/llm/client.js');
const { runFixRelay } = require('../src/runner.js');

// --- downgradeRisk ---

test('stepDown reduces each level by one', () => {
  assert.equal(stepDown('critical'), 'high');
  assert.equal(stepDown('high'), 'medium');
  assert.equal(stepDown('medium'), 'low');
  assert.equal(stepDown('low'), 'low');
});

test('decisionFor maps levels to decisions', () => {
  assert.equal(decisionFor('critical'), 'block');
  assert.equal(decisionFor('high'), 'block');
  assert.equal(decisionFor('medium'), 'warn');
  assert.equal(decisionFor('low'), 'allow');
});

test('downgradeRisk downgrades when allFalsePositive is true', () => {
  const risk = { level: 'high', decision: 'block', score: 50, reasons: ['original'] };
  const result = downgradeRisk(risk, { allFalsePositive: true });
  assert.equal(result.level, 'medium');
  assert.equal(result.decision, 'warn');
  assert.ok(result.reasons.some((r) => r.includes('downgraded')));
});

test('downgradeRisk returns same reference when allFalsePositive is false', () => {
  const risk = { level: 'high', decision: 'block', score: 50, reasons: [] };
  const result = downgradeRisk(risk, { allFalsePositive: false });
  assert.equal(result, risk);
});

test('downgradeRisk does not mutate original risk', () => {
  const risk = { level: 'critical', decision: 'block', score: 100, reasons: ['a'] };
  downgradeRisk(risk, { allFalsePositive: true });
  assert.equal(risk.level, 'critical');
});

test('downgradeRisk critical->high', () => {
  const risk = { level: 'critical', decision: 'block', score: 100, reasons: [] };
  assert.equal(downgradeRisk(risk, { allFalsePositive: true }).level, 'high');
});

test('downgradeRisk low stays low', () => {
  const risk = { level: 'low', decision: 'allow', score: 5, reasons: [] };
  const result = downgradeRisk(risk, { allFalsePositive: true });
  assert.equal(result, risk);
});

// --- parseLlmReview ---

test('parseLlmReview parses valid verdicts object', () => {
  const raw = JSON.stringify({ verdicts: [{ finding_id: 'a', verdict: 'true_positive', rationale: 'real' }] });
  const result = parseLlmReview(raw, ['a']);
  assert.equal(result.ok, true);
  assert.equal(result.verdicts[0].verdict, 'true_positive');
});

test('parseLlmReview parses bare array', () => {
  const raw = JSON.stringify([{ finding_id: 'b', verdict: 'false_positive', rationale: 'safe' }]);
  const result = parseLlmReview(raw, ['b']);
  assert.equal(result.ok, true);
  assert.equal(result.verdicts[0].verdict, 'false_positive');
});

test('parseLlmReview strips json fences', () => {
  const raw = '```json\n{"verdicts":[{"finding_id":"c","verdict":"uncertain","rationale":"?"}]}\n```';
  const result = parseLlmReview(raw, ['c']);
  assert.equal(result.ok, true);
  assert.equal(result.verdicts[0].verdict, 'uncertain');
});

test('parseLlmReview coerces unknown verdict to uncertain', () => {
  const raw = JSON.stringify([{ finding_id: 'd', verdict: 'maybe', rationale: '' }]);
  const result = parseLlmReview(raw, ['d']);
  assert.equal(result.ok, true);
  assert.equal(result.verdicts[0].verdict, 'uncertain');
});

test('parseLlmReview fills missing finding IDs with uncertain', () => {
  const raw = JSON.stringify({ verdicts: [] });
  const result = parseLlmReview(raw, ['missing-id']);
  assert.equal(result.ok, true);
  assert.equal(result.verdicts[0].finding_id, 'missing-id');
  assert.equal(result.verdicts[0].verdict, 'uncertain');
  assert.equal(result.verdicts[0].rationale, 'Missing from LLM response');
});

test('parseLlmReview returns ok:false on unparseable input', () => {
  const result = parseLlmReview('not json at all', []);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'non-json');
});

test('parseLlmReview returns ok:false for unexpected shape', () => {
  const result = parseLlmReview('"just a string"', []);
  assert.equal(result.ok, false);
});

// --- summarizeVerdicts ---

test('summarizeVerdicts sets allFalsePositive only when all are FP', () => {
  const verdicts = [
    { verdict: 'false_positive' },
    { verdict: 'false_positive' }
  ];
  const s = summarizeVerdicts(verdicts);
  assert.equal(s.allFalsePositive, true);
  assert.equal(s.falsePositive, 2);
  assert.equal(s.truePositive, 0);
  assert.equal(s.uncertain, 0);
});

test('summarizeVerdicts allFalsePositive is false when uncertain present', () => {
  const verdicts = [{ verdict: 'false_positive' }, { verdict: 'uncertain' }];
  assert.equal(summarizeVerdicts(verdicts).allFalsePositive, false);
});

test('summarizeVerdicts allFalsePositive is false when true_positive present', () => {
  const verdicts = [{ verdict: 'false_positive' }, { verdict: 'true_positive' }];
  assert.equal(summarizeVerdicts(verdicts).allFalsePositive, false);
});

test('summarizeVerdicts allFalsePositive is false when verdicts is empty', () => {
  assert.equal(summarizeVerdicts([]).allFalsePositive, false);
});

// --- readSnippet ---

test('readSnippet returns window around target line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-snippet-'));
  const file = path.join(tmp, 'src', 'test.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  fs.writeFileSync(file, content);

  const result = readSnippet({ file: 'src/test.js', line: 50, cwd: tmp, maxLines: 10 });
  assert.ok(result.content.includes('line 50'));
  assert.equal(result.startLine, 45);
  assert.equal(result.endLine, 54);
  assert.equal(result.truncated, true);
});

test('readSnippet clamps at file start', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-snippet-'));
  fs.writeFileSync(path.join(tmp, 'f.js'), 'a\nb\nc\nd\ne\n');
  const result = readSnippet({ file: 'f.js', line: 1, cwd: tmp, maxLines: 10 });
  assert.equal(result.startLine, 1);
});

test('readSnippet returns error for missing file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-snippet-'));
  const result = readSnippet({ file: 'nonexistent.js', line: 1, cwd: tmp });
  assert.equal(result.content, null);
  assert.equal(result.error, 'file-not-found');
});

test('readSnippet rejects path traversal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-snippet-'));
  const result = readSnippet({ file: '../../etc/passwd', line: 1, cwd: tmp });
  assert.equal(result.content, null);
  assert.equal(result.error, 'unsafe-path');
});

test('readSnippet rejects absolute paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-snippet-'));
  const result = readSnippet({ file: '/etc/passwd', line: 1, cwd: tmp });
  assert.equal(result.content, null);
  assert.equal(result.error, 'unsafe-path');
});

// --- buildReviewMessages ---

test('buildReviewMessages returns system and user messages', () => {
  const findings = [{ id: 'f1', scanner: 'Semgrep', ruleId: 'rule.x', severity: 'high', title: 'XSS', message: 'Unsafe', file: 'app.js', line: 10 }];
  const snippets = [{ file: 'app.js', startLine: 5, endLine: 15, content: 'const x = req.query.x', truncated: false }];
  const messages = buildReviewMessages({ findings, snippets });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('f1'));
  assert.ok(messages[1].content.includes('XSS'));
  assert.ok(messages[1].content.includes('const x = req.query.x'));
});

test('buildReviewMessages includes all finding IDs', () => {
  const findings = [
    { id: 'fa', scanner: 'S', ruleId: 'r1', severity: 'low', title: 'T1', message: 'M1', file: 'a.js', line: 1 },
    { id: 'fb', scanner: 'S', ruleId: 'r2', severity: 'low', title: 'T2', message: 'M2', file: 'b.js', line: 2 }
  ];
  const messages = buildReviewMessages({ findings, snippets: [] });
  assert.ok(messages[1].content.includes('fa'));
  assert.ok(messages[1].content.includes('fb'));
});

// --- runLlmReview (with fake httpClient) ---

function makeFinding(overrides = {}) {
  return { id: 'Semgrep:rule.x:auth/reset.js:12', scanner: 'Semgrep', ruleId: 'rule.x', severity: 'high', title: 'XSS', message: 'Unsafe', file: null, line: null, ...overrides };
}

function makeRisk(level = 'high') {
  return { level, decision: level === 'high' ? 'block' : 'allow', score: 50, reasons: ['original'] };
}

test('runLlmReview skips when findings are empty', async () => {
  const result = await runLlmReview({ findings: [], risk: makeRisk(), options: {} });
  assert.equal(result.ran, false);
  assert.equal(result.status, 'skipped-no-findings');
});

test('runLlmReview downgrades risk when all findings are false positives', async () => {
  const finding = makeFinding();
  const risk = makeRisk('high');
  const httpClient = async () => ({
    ok: true,
    content: JSON.stringify({ verdicts: [{ finding_id: finding.id, verdict: 'false_positive', rationale: 'Safe.' }] })
  });

  const result = await runLlmReview({
    findings: [finding],
    risk,
    options: { endpoint: 'https://api.example.com', model: 'test', apiKey: 'key' },
    httpClient
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.downgradedRisk.level, 'medium');
  assert.equal(result.review.downgrade.applied, true);
});

test('runLlmReview does not downgrade when true_positive present', async () => {
  const f1 = makeFinding({ id: 'f1' });
  const f2 = makeFinding({ id: 'f2' });
  const risk = makeRisk('high');
  const httpClient = async () => ({
    ok: true,
    content: JSON.stringify({ verdicts: [
      { finding_id: 'f1', verdict: 'true_positive', rationale: 'Real.' },
      { finding_id: 'f2', verdict: 'false_positive', rationale: 'Safe.' }
    ] })
  });

  const result = await runLlmReview({
    findings: [f1, f2],
    risk,
    options: { endpoint: 'https://api.example.com', model: 'test', apiKey: 'key' },
    httpClient
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.downgradedRisk.level, 'high');
  assert.equal(result.review.downgrade.applied, false);
});

test('runLlmReview falls back to deterministic risk on http timeout', async () => {
  const finding = makeFinding();
  const risk = makeRisk('high');
  const httpClient = async () => ({ ok: false, error: 'timeout' });

  const result = await runLlmReview({
    findings: [finding],
    risk,
    options: { endpoint: 'https://api.example.com', model: 'test', apiKey: 'key' },
    httpClient
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.downgradedRisk, risk);
  assert.equal(result.review.error, 'timeout');
});

test('runLlmReview falls back to deterministic risk on parser failure', async () => {
  const finding = makeFinding();
  const risk = makeRisk('high');
  const httpClient = async () => ({ ok: true, content: 'definitely not json' });

  const result = await runLlmReview({
    findings: [finding],
    risk,
    options: { endpoint: 'https://api.example.com', model: 'test', apiKey: 'key' },
    httpClient
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.downgradedRisk, risk);
});

// --- callChatCompletion (via local http server) ---

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('callChatCompletion returns content on 200 with valid envelope', async () => {
  const server = await startTestServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.ok(parsed.messages.length > 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdicts":[]}' } }] }));
    });
  });

  const { port } = server.address();
  const result = await callChatCompletion({
    endpoint: `http://127.0.0.1:${port}`,
    model: 'test-model',
    apiKey: 'test-key',
    messages: [{ role: 'user', content: 'hi' }],
    _protocol: 'http'
  });

  server.close();
  assert.equal(result.ok, true);
  assert.equal(result.content, '{"verdicts":[]}');
});

test('callChatCompletion returns http-401 on 401', async () => {
  const server = await startTestServer((req, res) => {
    res.writeHead(401);
    res.end('Unauthorized');
  });

  const { port } = server.address();
  const result = await callChatCompletion({
    endpoint: `http://127.0.0.1:${port}`,
    model: 'test',
    apiKey: 'bad',
    messages: [],
    _protocol: 'http'
  });

  server.close();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'http-401');
});

test('callChatCompletion returns timeout when server is slow', async () => {
  const server = await startTestServer((_req, _res) => {});

  const { port } = server.address();
  const result = await callChatCompletion({
    endpoint: `http://127.0.0.1:${port}`,
    model: 'test',
    apiKey: 'key',
    messages: [],
    timeoutMs: 50,
    _protocol: 'http'
  });

  server.close();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
});

test('callChatCompletion returns invalid-response for non-JSON body', async () => {
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>Gateway Error</html>');
  });

  const { port } = server.address();
  const result = await callChatCompletion({
    endpoint: `http://127.0.0.1:${port}`,
    model: 'test',
    apiKey: 'key',
    messages: [],
    _protocol: 'http'
  });

  server.close();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-response');
});

// --- runFixRelay integration with LLM review ---

test('runFixRelay with llmReview:true writes llm-review.json and downgrades risk', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-llm-int-'));
  const sarifPath = path.join(tmp, 'scan.sarif');
  const diffPath = path.join(tmp, 'pr.diff');
  const outDir = path.join(tmp, 'out');

  fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'TestScanner', rules: [{ id: 'rule.x', shortDescription: { text: 'XSS' } }] } },
      results: [{
        ruleId: 'rule.x',
        level: 'error',
        message: { text: 'Unsafe input' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js' }, region: { startLine: 5 } } }]
      }]
    }]
  }));

  fs.writeFileSync(diffPath, [
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '@@ -1,1 +1,2 @@',
    '+const x = 1;'
  ].join('\n'));

  const fakeClient = async () => ({
    ok: true,
    content: JSON.stringify({ verdicts: [{ finding_id: 'TestScanner:rule.x:app.js:5', verdict: 'false_positive', rationale: 'Constant value.' }] })
  });

  const summary = await runFixRelay({
    sarifPaths: [sarifPath],
    diffFile: diffPath,
    outDir,
    failOn: 'never',
    llmReview: true,
    llmEndpoint: 'https://api.example.com',
    llmModel: 'test',
    llmApiKey: 'key',
    _httpClient: fakeClient
  });

  assert.ok(summary.artifacts.llmReview, 'llm-review.json path should be set');
  assert.ok(fs.existsSync(summary.artifacts.llmReview), 'llm-review.json should exist');

  const llmReview = JSON.parse(fs.readFileSync(summary.artifacts.llmReview, 'utf8'));
  assert.equal(llmReview.status, 'ok');
  assert.equal(llmReview.downgrade.applied, true);
  assert.equal(summary.risk.level, 'medium');
});

test('runFixRelay with llmReview:true and failing client preserves deterministic risk', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-llm-fail-'));
  const sarifPath = path.join(tmp, 'scan.sarif');
  const diffPath = path.join(tmp, 'pr.diff');
  const outDir = path.join(tmp, 'out');

  fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'TestScanner', rules: [{ id: 'rule.y', shortDescription: { text: 'SQLi' } }] } },
      results: [{
        ruleId: 'rule.y',
        level: 'error',
        message: { text: 'SQL injection' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'db.js' }, region: { startLine: 3 } } }]
      }]
    }]
  }));

  fs.writeFileSync(diffPath, [
    'diff --git a/db.js b/db.js',
    '--- a/db.js',
    '+++ b/db.js',
    '@@ -1,1 +1,2 @@',
    '+const q = 1;'
  ].join('\n'));

  const fakeClient = async () => ({ ok: false, error: 'timeout' });

  const summary = await runFixRelay({
    sarifPaths: [sarifPath],
    diffFile: diffPath,
    outDir,
    failOn: 'never',
    llmReview: true,
    llmEndpoint: 'https://api.example.com',
    llmModel: 'test',
    llmApiKey: 'key',
    _httpClient: fakeClient
  });

  assert.equal(summary.risk.level, 'high');
  const llmReview = JSON.parse(fs.readFileSync(summary.artifacts.llmReview, 'utf8'));
  assert.equal(llmReview.status, 'failed');
  assert.equal(llmReview.error, 'timeout');
});

test('runFixRelay without llmReview produces unchanged artifacts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrelay-no-llm-'));
  const outDir = path.join(tmp, 'out');

  const summary = await runFixRelay({
    sarifPaths: [],
    scannerJsonPaths: [],
    diffFile: undefined,
    outDir,
    failOn: 'never'
  });

  assert.equal(summary.artifacts.llmReview, undefined);
  assert.ok(fs.existsSync(summary.artifacts.report));
});
