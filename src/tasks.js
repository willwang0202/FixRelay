const { inferPackageManager, likelyTestFile } = require('./paths.js');

function validationCommands(files, packageManager = 'generic') {
  const tests = files.map(likelyTestFile).filter(Boolean);
  if (packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
    const runner = packageManager === 'npm' ? 'npm test --' : `${packageManager} test`;
    return [
      tests.length > 0 ? `${runner} ${tests.join(' ')}` : `${packageManager} test`,
      packageManager === 'npm' ? 'npm run lint --if-present' : `${packageManager} lint`
    ];
  }
  if (packageManager === 'python') return ['pytest', 'ruff check .'];
  if (packageManager === 'go') return ['go test ./...'];
  return ['run the relevant test suite', 'run the relevant lint or scanner command'];
}

function generateAgentTasks(findings, diffContext, risk, options = {}) {
  const packageManager = options.packageManager || inferPackageManager(options.cwd);

  return findings.map((finding) => {
    const targetFiles = finding.file ? [finding.file] : [];
    const relatedTests = targetFiles.map(likelyTestFile).filter(Boolean);
    return {
      task_type: 'security_fix',
      severity: finding.severity,
      merge_risk: risk.level,
      finding: finding.message,
      scanner: finding.scanner,
      rule_id: finding.ruleId,
      title: finding.title,
      target_files: targetFiles,
      related_tests: relatedTests,
      constraints: [
        'Keep the fix minimal and focused on the reported security issue',
        'Preserve existing public API behavior',
        'Do not refactor unrelated files',
        'Do not suppress the scanner rule unless this is a confirmed false positive',
        'Add or update regression tests for the security behavior'
      ],
      validation_commands: validationCommands(targetFiles, packageManager)
    };
  });
}

function taskPrompt(task) {
  return [
    'You are fixing a security issue in this repository.',
    '',
    'Task:',
    `Fix the reported ${task.severity} security finding: ${task.title}.`,
    '',
    'Context:',
    `- Scanner: ${task.scanner}`,
    `- Rule: ${task.rule_id}`,
    `- Finding: ${task.finding}`,
    `- Target files: ${task.target_files.join(', ') || 'not specified by scanner'}`,
    `- Related test files: ${task.related_tests.join(', ') || 'infer and add the closest regression test'}`,
    '',
    'Constraints:',
    ...task.constraints.map((constraint) => `- ${constraint}`),
    '',
    'Validation:',
    'Run:',
    ...task.validation_commands.map((command) => `- ${command}`),
    '',
    'Final response:',
    'Summarize changed files, explain why the fix resolves the vulnerability, and mention tests run.'
  ].join('\n');
}

function generatePromptBundle(tasks) {
  if (tasks.length === 0) {
    return 'No scanner findings were loaded. Re-run FixRelay with SARIF or scanner JSON output to generate a fix prompt.';
  }

  return tasks.map((task, index) => {
    const heading = tasks.length === 1 ? '# FixRelay Agent Prompt' : `# FixRelay Agent Prompt ${index + 1}`;
    return `${heading}\n\n${taskPrompt(task)}`;
  }).join('\n\n---\n\n');
}

module.exports = {
  generateAgentTasks,
  generatePromptBundle,
  taskPrompt,
  validationCommands
};
