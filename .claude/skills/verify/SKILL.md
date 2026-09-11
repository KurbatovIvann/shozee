---
name: verify
description: Run Showzy's local CI-equivalent checks for the current branch (affected packages only, compact output) and fix what fails.
argument-hint: "[--full] [--only steps] [--db on|off] [--dry-run]"
disable-model-invocation: true
---

# /verify

Run `node .claude/scripts/verify.mjs $ARGUMENTS`.

- The script formats changed files, runs typecheck/lint/unit tests on the
  affected packages, the DB suite for changed server packages (Docker
  required), and contract/migration/bundle/web gates only when their inputs
  changed. `--full` mirrors all CI jobs incl. build and e2e smoke.
- Read the printed summary. For a failure, read the tail shown; open the full
  log in `.claude/.verify/<step>.log` only around the failing lines.
- Fix failures that belong to this branch and re-run only the failed steps
  with `--only <step>`. A red test in an untouched area is a flake or a
  regression, not a retry (`docs/operations/ci-flakes.md`).
- Report the final `RESULT:` line and anything not run.
