# FixRelay

FixRelay turns existing security scanner output into PR merge-risk summaries and
ready-to-run AI agent fix prompts.

It is not a scanner and does not call a hosted LLM. The MVP runs locally in CI,
reads scanner artifacts such as SARIF, scores PR risk from deterministic rules,
and writes:

- `merge-risk-report.md`: PR-comment-ready summary and AI agent prompt.
- `agent-fix-tasks.json`: machine-readable fix tasks.
- `normalized-findings.json`: scanner-neutral finding records with diff context.
- `prompt.md`: standalone agent prompt bundle.
- `summary.json`: risk, decision, finding count, and artifact paths.

## Quick Start

Create `.github/workflows/fixrelay.yml` in the repository you want to protect:

```yaml
name: FixRelay

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  fixrelay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Semgrep
        run: python -m pip install semgrep

      - name: Run Semgrep
        run: semgrep scan --config auto --sarif --output semgrep.sarif || true

      - name: Run FixRelay
        uses: willwang0202/FixRelay@v0
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          sarif: semgrep.sarif
          diff: origin/${{ github.base_ref }}...HEAD
          scope: pr
          fail-on: high
          post-comment: true
          protected-paths: |
            auth/
            billing/
            infra/
            .github/workflows/
```

This is the same setup tested against a private repository. On an empty PR,
FixRelay posts a low-risk comment when Semgrep finds only pre-existing issues
outside the PR diff. Pin `uses:` to a commit SHA for maximum stability, or use
`@v0` to receive backwards-compatible patch updates automatically.

If the check passes but no PR comment appears, open the target repository's
GitHub settings and confirm Actions can use read/write workflow permissions.
FixRelay needs `issues: write` to create or update the PR comment.

To check every scanner finding instead of only PR-relevant findings, change the
FixRelay step to:

```yaml
with:
  sarif: semgrep.sarif
  diff: origin/${{ github.base_ref }}...HEAD
  scope: entire-repo
```

## Local Usage

Run from this repository:

```bash
npm test
node bin/fixrelay.js generate \
  --sarif examples/semgrep.sarif \
  --diff-file examples/pr.diff \
  --out-dir fixrelay-out \
  --fail-on never
```

FixRelay is not published to npm yet. In another local checkout, use the cloned
repository path directly, or install from GitHub once you are ready to consume it
as a dependency.

## CLI Options

```text
fixrelay generate --sarif <file> [--diff <range>|--diff-file <file>] [options]
```

Common options:

- `--sarif <file>`: SARIF scanner output. Can be repeated.
- `--scanner-json <file>`: Generic scanner JSON output. Can be repeated.
- `--diff <range>`: Git diff range, such as `origin/main...HEAD`.
- `--diff-file <file>`: Saved unified diff.
- `--out-dir <dir>`: Artifact directory. Defaults to `fixrelay-out`.
- `--fail-on <level>`: `low`, `medium`, `high`, `critical`, or `never`.
- `--scope <scope>`: `pr` or `entire-repo`. Defaults to `pr`.
- `--pr-title <text>` and `--pr-body <text>`: PR context for the report.
- `--protected-path <path>`: Protected path prefix. Can be repeated.
- `--package-manager <pm>`: Validation hint source, such as `npm` or `go`.

By default, FixRelay focuses on PR-relevant findings: scanner findings whose
files appear in the provided diff. This prevents an empty PR from being blocked
by unrelated pre-existing findings from a whole-repository scanner run.

Use `--scope entire-repo` when you intentionally want FixRelay to evaluate every
finding in the scanner artifact, even when the finding is outside the PR diff.

## GitHub Action

Run your scanners first, then run FixRelay. This is the tested workflow shape:

```yaml
name: FixRelay

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  fixrelay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Semgrep
        run: python -m pip install semgrep

      - name: Run Semgrep
        run: semgrep scan --config auto --sarif --output semgrep.sarif || true

      - name: Run FixRelay
        uses: willwang0202/FixRelay@v0
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          sarif: semgrep.sarif
          diff: origin/${{ github.base_ref }}...HEAD
          scope: pr
          fail-on: high
          post-comment: true
          protected-paths: |
            auth/
            billing/
            infra/
            .github/workflows/
```

For local development of this repository, use:

```yaml
- name: Run FixRelay
  uses: ./
  with:
    sarif: semgrep.sarif
    diff: origin/${{ github.base_ref }}...HEAD
```

The action posts or updates a single PR comment identified by FixRelay markers,
so repeated CI runs update the same comment.

The action defaults to `scope: pr`, which only reports findings in changed
files. To make FixRelay check the entire scanner result, set:

```yaml
with:
  sarif: semgrep.sarif
  diff: origin/${{ github.base_ref }}...HEAD
  scope: entire-repo
```

Action outputs expose absolute paths to the generated artifacts:

- `risk`: calculated merge risk level.
- `decision`: `allow`, `warn`, or `block`.
- `report`: `merge-risk-report.md`.
- `tasks`: `agent-fix-tasks.json`.
- `findings`: `normalized-findings.json`.
- `prompt`: `prompt.md`.

## Example PR Comment

```markdown
Merge Risk: High

This PR should not be merged until the security finding is fixed.

Why:
- High severity finding from Semgrep: Unsanitized response body
- Finding touches protected path auth/reset.js
- No test changes were detected in this PR

AI Agent Fix Prompt:
Copy this into Claude Code, Codex, Cursor Agent, or another coding agent:
...
```

## Risk Scoring

FixRelay scores deterministic signals:

- Scanner severity.
- Finding appears in a changed file.
- Finding appears on a changed line.
- Protected paths such as `auth/`, `billing/`, `infra/`, and
  `.github/workflows/`.
- Missing test changes.
- CI/CD workflow changes.
- Dependency manifest or lockfile changes.

In `pr` scope, only findings in changed files are scored, reported, and turned
into agent tasks. In `entire-repo` scope, all loaded scanner findings are scored
and reported; diff context is still used for changed-file and changed-line
signals when available.

Decisions:

- `allow`: low risk.
- `warn`: medium risk.
- `block`: high or critical risk.

## Optional LLM Review

FixRelay can run an optional LLM triage pass after the deterministic scoring step.
The LLM reads the actual code snippets around each finding and classifies each one
as `true_positive`, `false_positive`, or `uncertain`. If **all** findings are
classified as false positives, the risk level is downgraded by one step
(`critical→high`, `high→medium`, `medium→low`). The LLM can never upgrade risk —
only downgrade it.

### Inputs

| Input | Description |
|---|---|
| `llm-review` | Set to `true` to enable. Default: `false`. |
| `llm-endpoint` | OpenAI-compatible base URL. Works with LiteLLM proxies. |
| `llm-model` | Model name passed to the endpoint, e.g. `claude-sonnet-4-6`, `gpt-4o-mini`. |
| `llm-timeout-ms` | Milliseconds before the call times out. Default: `20000`. |
| `llm-max-snippet-lines` | Lines of code included per finding. Default: `40`. |

Pass your API key as `LLM_API_KEY` in the environment — never as an action input.

### Example workflow

```yaml
- name: Run FixRelay with LLM triage
  uses: willwang0202/FixRelay@v0
  id: fixrelay
  env:
    GITHUB_TOKEN: ${{ github.token }}
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
  with:
    sarif: semgrep.sarif
    diff: origin/${{ github.base_ref }}...HEAD
    llm-review: true
    llm-endpoint: https://api.anthropic.com
    llm-model: claude-haiku-4-5-20251001
```

To use a LiteLLM proxy (for on-prem inference or provider-neutral routing):

```yaml
    llm-endpoint: https://your-litellm-proxy.internal
    llm-model: ollama/codellama
```

### Behavior on failure

If the LLM call times out, returns a non-200 status, or produces a response that
cannot be parsed, FixRelay logs a warning and falls back to the deterministic risk
score. The `llm-review.json` artifact is still written with `"status": "failed"` so
you can inspect the error.

### New artifact: `llm-review.json`

```json
{
  "status": "ok",
  "model": "claude-haiku-4-5-20251001",
  "endpoint_host": "api.anthropic.com",
  "elapsed_ms": 1432,
  "summary": {
    "total_reviewed": 2,
    "true_positive": 0,
    "false_positive": 2,
    "uncertain": 0,
    "all_false_positive": true
  },
  "downgrade": { "applied": true, "from_level": "high", "to_level": "medium" },
  "verdicts": [
    { "finding_id": "...", "verdict": "false_positive", "rationale": "Constant value, not user-controlled." }
  ]
}
```

The artifact path is exposed as the `llm-review-artifact` action output.

### Downgrade-only design

The LLM triage layer can only reduce the risk score, never raise it. This prevents
a hallucinated `true_positive` from blocking a PR that the deterministic layer
already cleared. If you need the LLM to catch issues the scanner missed, run it as
a separate step and evaluate its output independently.

## Limitations

- **FixRelay is not a scanner.** It reads existing scanner artifacts (SARIF,
  generic JSON) and does not find vulnerabilities itself.
- **It only interprets scanner artifacts.** The quality of FixRelay's risk
  assessment is bounded by the quality and coverage of the scanner you run
  before it.
- **`scope: pr` filters by changed files, not exact vulnerability introduction.**
  A finding is included when its file appears in the diff. FixRelay cannot
  determine whether the vulnerability was introduced by the PR or was
  pre-existing in that file.
- **BUSL-1.1 license.** FixRelay is not open-source. Internal and personal use
  is permitted. Providing it as a hosted or managed service to third parties
  requires a commercial license.

## Privacy Posture

FixRelay is local-first. It reads local scanner outputs and git diff context,
writes local artifacts, and only sends data to GitHub when `post-comment: true`
is enabled inside GitHub Actions. It does not ingest a full codebase, train on
code, or store source code.

LLM review is **opt-in and disabled by default**. When enabled, code snippets
around each finding are sent to the configured `llm-endpoint`. If your code is
sensitive, self-host a LiteLLM proxy pointing at a local model rather than
routing snippets to a public API.

## License

FixRelay is licensed under the Business Source License 1.1 (`BUSL-1.1`). You may
use it in production for your own internal repositories, CI/CD systems, security
workflows, and private infrastructure. You may not use it to provide a hosted
service, managed service, commercial product, paid integration, or substantially
similar security-to-agent remediation product to third parties without a
commercial license.

The Change Date is `2030-05-14`. On that date, or the fourth anniversary of the
first public distribution of a specific version if earlier, that version changes
to the Apache License 2.0.

## Development

```bash
npm test
node bin/fixrelay.js generate \
  --sarif examples/semgrep.sarif \
  --diff-file examples/pr.diff \
  --out-dir tmp/fixrelay-demo \
  --fail-on never
```
