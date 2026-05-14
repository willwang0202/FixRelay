const LANG_MAP = {
  js: 'javascript', ts: 'typescript', py: 'python', go: 'go',
  rb: 'ruby', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c',
  rs: 'rust', php: 'php', kt: 'kotlin', swift: 'swift', sh: 'bash'
};

function langFromFile(file) {
  const ext = String(file || '').split('.').pop().toLowerCase();
  return LANG_MAP[ext] || '';
}

const SYSTEM_PROMPT = `You are a security triage assistant reviewing static analyzer findings.

Your output MUST be a single JSON object matching this schema exactly:
{"verdicts":[{"finding_id":"<string>","verdict":"<true_positive|false_positive|uncertain>","rationale":"<string, max 280 chars>"}]}

Rules:
- Allowed verdict values: true_positive, false_positive, uncertain
- true_positive: the code shown is exploitable or violates the rule as written
- false_positive: you are confident the rule does not apply (sanitizer present, input is constant, dead code, test fixture)
- uncertain: insufficient context or ambiguous — use this when in doubt
- Bias toward uncertain over false_positive when context is incomplete
- Every finding_id in the request must appear in your response
- No prose, no explanation, no markdown outside the JSON object`;

const EXAMPLE = `Example response:
{"verdicts":[{"finding_id":"Semgrep:rule.x:auth/reset.js:12","verdict":"true_positive","rationale":"User input flows into query without sanitization on line 12."},{"finding_id":"Semgrep:rule.y:utils/fmt.js:5","verdict":"false_positive","rationale":"escape() on line 4 sanitizes the value before use."}]}`;

function buildReviewMessages({ findings, snippets, prTitle }) {
  const snippetMap = new Map((snippets || []).map((s) => [s.file, s]));

  const findingBlocks = findings.map((finding) => {
    const snippet = finding.file ? snippetMap.get(finding.file) : null;
    const lines = [
      `### Finding ${finding.id}`,
      `Scanner: ${finding.scanner}`,
      `Rule: ${finding.ruleId}`,
      `Severity: ${finding.severity}`,
      `Title: ${finding.title}`,
      `Message: ${finding.message}`,
      `Location: ${finding.file || 'unknown'}${finding.line ? `:${finding.line}` : ''}`
    ];

    if (snippet?.content != null) {
      const lang = langFromFile(finding.file);
      lines.push('');
      lines.push(`Code (lines ${snippet.startLine}-${snippet.endLine}${snippet.truncated ? ', truncated' : ''}):`);
      lines.push(`\`\`\`${lang}`);
      lines.push(snippet.content);
      lines.push('```');
    } else if (snippet?.error) {
      lines.push(`(Code unavailable: ${snippet.error})`);
    }

    return lines.join('\n');
  });

  const userLines = [
    prTitle ? `PR: ${prTitle}` : '',
    prTitle ? '' : '',
    ...findingBlocks,
    '',
    'Return the JSON object now. Do not include any explanation outside the JSON.'
  ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));

  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${EXAMPLE}` },
    { role: 'user', content: userLines.join('\n') }
  ];
}

module.exports = { buildReviewMessages };
