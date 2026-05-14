const { annotateFindings, applyScannerFileFallback, parseUnifiedDiff } = require('./diff.js');
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
const { RISK_ORDER, scoreRisk, shouldFail, titleCase } = require('./risk.js');
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
  parseUnifiedDiff,
  readDiff,
  readJsonFile,
  runFixRelay,
  scoreRisk,
  selectFindingsForScope,
  serializeFinding,
  shouldFail,
  taskPrompt,
  titleCase,
  validationCommands
};
