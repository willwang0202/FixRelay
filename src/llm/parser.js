function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function coerceVerdict(value) {
  if (value === 'true_positive' || value === 'false_positive' || value === 'uncertain') return value;
  return 'uncertain';
}

function parseLlmReview(rawContent, expectedFindingIds = []) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(String(rawContent || '')));
  } catch {
    return { ok: false, error: 'non-json' };
  }

  const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.verdicts) ? parsed.verdicts : null);
  if (!raw) return { ok: false, error: 'unexpected-shape' };

  const byId = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry.finding_id !== 'string') continue;
    byId.set(entry.finding_id, {
      finding_id: entry.finding_id,
      verdict: coerceVerdict(entry.verdict),
      rationale: String(entry.rationale || '').slice(0, 280)
    });
  }

  const verdicts = expectedFindingIds.map((id) =>
    byId.get(id) || { finding_id: id, verdict: 'uncertain', rationale: 'Missing from LLM response' }
  );

  return { ok: true, verdicts };
}

module.exports = { parseLlmReview };
