const { RISK_ORDER } = require('../risk.js');

function decisionFor(level) {
  if (level === 'critical' || level === 'high') return 'block';
  if (level === 'medium') return 'warn';
  return 'allow';
}

function stepDown(level) {
  const index = RISK_ORDER.indexOf(level);
  if (index <= 0) return level;
  return RISK_ORDER[index - 1];
}

function downgradeRisk(risk, reviewSummary) {
  if (!reviewSummary.allFalsePositive) return risk;

  const newLevel = stepDown(risk.level);
  if (newLevel === risk.level) return risk;

  return {
    ...risk,
    level: newLevel,
    decision: decisionFor(newLevel),
    reasons: [
      ...risk.reasons,
      `LLM review classified all findings as false positives; risk downgraded from ${risk.level} to ${newLevel}`
    ]
  };
}

module.exports = { decisionFor, downgradeRisk, stepDown };
