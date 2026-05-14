const { callChatCompletion } = require('./client.js');
const { downgradeRisk } = require('./downgrade.js');
const { parseLlmReview } = require('./parser.js');
const { buildReviewMessages } = require('./prompt.js');
const { readSnippet } = require('./snippet.js');

function summarizeVerdicts(verdicts) {
  const truePositive = verdicts.filter((v) => v.verdict === 'true_positive').length;
  const falsePositive = verdicts.filter((v) => v.verdict === 'false_positive').length;
  const uncertain = verdicts.filter((v) => v.verdict === 'uncertain').length;
  return {
    totalReviewed: verdicts.length,
    truePositive,
    falsePositive,
    uncertain,
    allFalsePositive: falsePositive > 0 && truePositive === 0 && uncertain === 0
  };
}

async function runLlmReview({ findings, risk, options = {}, cwd = process.cwd(), httpClient = callChatCompletion }) {
  if (findings.length === 0) {
    return { ran: false, status: 'skipped-no-findings', review: null, downgradedRisk: risk };
  }

  const { endpoint, model, apiKey, timeoutMs = 20000, maxSnippetLines = 40 } = options;

  const snippets = findings
    .filter((f) => f.file)
    .map((f) => readSnippet({ file: f.file, line: f.line, cwd, maxLines: maxSnippetLines }));

  const messages = buildReviewMessages({ findings, snippets, prTitle: options.prTitle });
  const findingIds = findings.map((f) => f.id);

  const started = Date.now();
  const clientResult = await httpClient({ endpoint, model, apiKey, messages, timeoutMs });
  const elapsedMs = Date.now() - started;

  let endpointHost;
  try { endpointHost = new URL(endpoint).hostname; } catch { endpointHost = 'unknown'; }

  if (!clientResult.ok) {
    const review = { ran: true, status: 'failed', model, endpoint_host: endpointHost, elapsed_ms: elapsedMs, error: clientResult.error, summary: null, downgrade: null, verdicts: [] };
    return { ran: true, status: 'failed', review, downgradedRisk: risk };
  }

  const parsed = parseLlmReview(clientResult.content, findingIds);
  if (!parsed.ok) {
    const review = { ran: true, status: 'failed', model, endpoint_host: endpointHost, elapsed_ms: elapsedMs, error: parsed.error, summary: null, downgrade: null, verdicts: [] };
    return { ran: true, status: 'failed', review, downgradedRisk: risk };
  }

  const verdicts = parsed.verdicts.map((v) => {
    const finding = findings.find((f) => f.id === v.finding_id);
    const snippet = finding?.file ? snippets.find((s) => s.file === finding.file) : null;
    return {
      ...v,
      snippet_lines: snippet ? `${snippet.startLine}-${snippet.endLine}` : null,
      snippet_truncated: snippet?.truncated ?? null
    };
  });

  const summary = summarizeVerdicts(verdicts);
  const downgradedRisk = downgradeRisk(risk, summary);
  const downgradeApplied = downgradedRisk.level !== risk.level;

  const review = {
    ran: true,
    status: 'ok',
    model,
    endpoint_host: endpointHost,
    elapsed_ms: elapsedMs,
    error: null,
    summary,
    downgrade: { applied: downgradeApplied, from_level: risk.level, to_level: downgradedRisk.level },
    verdicts
  };

  return { ran: true, status: 'ok', review, downgradedRisk };
}

module.exports = { runLlmReview, summarizeVerdicts };
