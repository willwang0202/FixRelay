const { taskPrompt } = require('./tasks.js');
const { titleCase } = require('./risk.js');

function generateReport(findings, diffContext, risk, tasks, options = {}) {
  const heading = `Merge Risk: ${titleCase(risk.level)}`;
  const decisionText = {
    allow: 'This PR can proceed from the loaded scanner context.',
    warn: 'This PR should be reviewed before merge.',
    block: 'This PR should not be merged until the security finding is fixed.'
  }[risk.decision];

  const topFindings = findings.slice(0, 3).map((finding, index) => (
    `${index + 1}. ${titleCase(finding.severity)} - ${finding.title} (${finding.file || 'unknown file'}${finding.line ? `:${finding.line}` : ''})`
  ));

  const prompt = tasks[0]
    ? taskPrompt(tasks[0])
    : 'No scanner findings were loaded. Re-run FixRelay with SARIF or scanner JSON output to generate a fix prompt.';

  const lines = [
    '<!-- fixrelay-comment:start -->',
    `# ${heading}`,
    '',
    decisionText,
    '',
    `Score: ${risk.score}`,
    options.prTitle ? `PR: ${options.prTitle}` : '',
    '',
    '## Why',
    ...risk.reasons.map((reason) => `- ${reason}`),
    '',
    findings.length > 0 ? '## Top Findings' : '',
    ...topFindings,
    '',
    '## Recommended Action',
    risk.decision === 'allow'
      ? 'Continue normal review and keep scanner artifacts attached to CI.'
      : 'Fix the finding, add or update regression tests, and rerun the scanner before merge.',
    '',
    '## AI Agent Fix Prompt',
    '',
    'Copy this into Claude Code, Codex, Cursor Agent, or another coding agent:',
    '',
    '```markdown',
    prompt,
    '```',
    '',
    '## Machine-Readable Tasks',
    '',
    `Generated ${tasks.length} security fix task${tasks.length === 1 ? '' : 's'} in \`agent-fix-tasks.json\`.`,
    '<!-- fixrelay-comment:end -->',
    ''
  ];

  return lines
    .filter((line, index) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

module.exports = {
  generateReport
};
