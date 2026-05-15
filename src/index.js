const { annotateFindings, applyScannerFileFallback, parseUnifiedDiff } = require('./diff.js');
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
const {
  generateAgentTasks,
  generatePromptBundle,
  taskPrompt,
  validationCommands
} = require('./tasks.js');

module.exports = {
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SCOPE,
  RISK_ORDER,
  annotateFindings,
  applyScannerFileFallback,
  buildReviewMessages,
  callChatCompletion,
  downgradeRisk,
  generateAgentTasks,
  generatePromptBundle,
  generateReport,
  inferPackageManager,
  isDependencyManifest,
  isProtectedPath,
  isTestPath,
  likelyTestFile,
  loadFindingsFromSarif,
  loadFindingsFromScannerJson,
  normalizePath,
  normalizeScope,
  normalizeSeverity,
  parseLlmReview,
  parseUnifiedDiff,
  readDiff,
  readJsonFile,
  readSnippet,
  runFixRelay,
  runLlmReview,
  scoreRisk,
  selectFindingsForScope,
  serializeFinding,
  shouldFail,
  summarizeVerdicts,
  taskPrompt,
  titleCase,
  unknownRisk,
  validationCommands
};
