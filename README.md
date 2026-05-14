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

After publishing to npm, the same CLI can be run with:

```bash
npx fixrelay generate \
  --sarif semgrep.sarif \
  --diff origin/main...HEAD \
  --out-dir fixrelay-out \
  --fail-on high
```

Or installed into a project:

```bash
npm install --save-dev fixrelay
npx fixrelay generate --sarif semgrep.sarif --diff origin/main...HEAD
```

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
- `--pr-title <text>` and `--pr-body <text>`: PR context for the report.
- `--protected-path <path>`: Protected path prefix. Can be repeated.
- `--package-manager <pm>`: Validation hint source, such as `npm` or `go`.

## GitHub Action

Run your scanners first, then run FixRelay:

```yaml
name: FixRelay

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read
  issues: write

jobs:
  fixrelay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Semgrep
        run: semgrep scan --sarif --output semgrep.sarif || true

      - name: Run FixRelay
        uses: your-org/FixRelay@v0
        with:
          sarif: semgrep.sarif
          diff: origin/${{ github.base_ref }}...HEAD
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

Decisions:

- `allow`: low risk.
- `warn`: medium risk.
- `block`: high or critical risk.

## Privacy Posture

FixRelay is local-first. It reads local scanner outputs and git diff context,
writes local artifacts, and only sends data to GitHub when `post-comment: true`
is enabled inside GitHub Actions. It does not ingest a full codebase, call a
hosted model, train on code, or store source code.

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
