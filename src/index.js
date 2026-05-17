const { annotateFindings, applyScannerFileFallback, parseUnifiedDiff } = require('./diff.js');
const {
  FIXRELAY_HOOK_MARKER,
  HOOK_SCRIPT_TEMPLATE,
  getStagedDiff,
  getStagedFiles,
  getHooksDir,
  removeHook,
  runHookCheck,
  writeHook
} = require('./hook.js');
const { callChatCompletion } = require('./llm/client.js');
const { downgradeRisk } = require('./llm/downgrade.js');
const { parseLlmReview } = require('./llm/parser.js');
const { buildReviewMessages } = require('./llm/prompt.js');
const { runLlmReview, summarizeVerdicts } = require('./llm/review.js');
const { readSnippet } = require('./llm/snippet.js');
const {
  loadFindingsFromSarif,
  loadFindingsFromScannerJson,
  normalizeSeverity,
  serializeFinding
} = require('./findings.js');
const { compareFindings, loadOutcome, severityGate } = require('./outcome.js');
const {
  DEFAULT_PROTECTED_PATHS,
  inferPackageManager,
  isDependencyManifest,
  isProtectedPath,
  isTestPath,
  likelyTestFile,
  normalizePath
} = require('./paths.js');
const { generateReport } = require('./report.js');
const { RISK_ORDER, scoreRisk, shouldFail, titleCase, unknownRisk } = require('./risk.js');
const { DEFAULT_SCOPE, normalizeScope, readDiff, readJsonFile, runFixRelay, selectFindingsForScope } = require('./runner.js');
const { runSemgrep, runSemgrepOnFiles, semgrepAvailable } = require('./scanner.js');
const {
  generateAgentTasks,
  generatePromptBundle,
  taskPrompt,
  validationCommands
} = require('./tasks.js');

module.exports = {
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SCOPE,
  FIXRELAY_HOOK_MARKER,
  HOOK_SCRIPT_TEMPLATE,
  RISK_ORDER,
  annotateFindings,
  applyScannerFileFallback,
  buildReviewMessages,
  callChatCompletion,
  compareFindings,
  downgradeRisk,
  generateAgentTasks,
  generatePromptBundle,
  generateReport,
  getHooksDir,
  getStagedDiff,
  getStagedFiles,
  inferPackageManager,
  isDependencyManifest,
  isProtectedPath,
  isTestPath,
  likelyTestFile,
  loadFindingsFromSarif,
  loadFindingsFromScannerJson,
  loadOutcome,
  normalizePath,
  normalizeScope,
  normalizeSeverity,
  parseLlmReview,
  parseUnifiedDiff,
  readDiff,
  readJsonFile,
  readSnippet,
  removeHook,
  runFixRelay,
  runHookCheck,
  runLlmReview,
  runSemgrep,
  runSemgrepOnFiles,
  scoreRisk,
  selectFindingsForScope,
  semgrepAvailable,
  serializeFinding,
  severityGate,
  shouldFail,
  summarizeVerdicts,
  taskPrompt,
  titleCase,
  unknownRisk,
  validationCommands,
  writeHook
};
