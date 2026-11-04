---
name: hand-over
description: How pr-daemon (and anyone working on it) hands a task to the owner. Use when writing or changing any PR comment, issue comment, notification, status-page message, error, doctor output or doc line that asks a human to do something, and when telling the owner in chat what they need to run.
---

# Handing a task to the owner

When pr-daemon can't or shouldn't do something itself, a person has to. Make
that as easy as possible: **the message is the instructions**, ready to
follow without thinking or looking anything up.

## Every hand-over says

1. **What happened and why it's theirs**, in one or two sentences. Name the
   guard or limit ("its gh login can't push workflow files"), not just the
   symptom.
2. **Every command, in order, in one fenced `bash` block**, filled in with the
   real repo, branch, base, file paths and check command. Never "resolve,
   commit and push" or "run the usual". Start from fetching the branch, so it
   works from any checkout.
   - Data the person must apply goes *inside* the block (a heredoc for a
     diff: `git apply <<'PR_DAEMON_DIFF'`), so one paste does it.
   - Quote paths that came from a repo (`'it''s.txt'` style).
   - Prerequisites come first: secrets (`gh secret set NAME -R owner/repo`),
     logins, config lines.
3. **The browser way too**, with the exact URL, when there is one (editing a
   file, repo settings, the PR's Update branch button).
4. **How to back out** (`git merge --abort`) and **what happens if they do
   nothing**.
5. **The pr-daemon way, if there is one**: e.g. comment
   `/pr-daemon <guidance>` to have the agent try again.

## Also

- Say which login or machine to run it from when that matters (their own
  checkout, not pr-daemon's worktree under `~/.pr-daemon/`).
- Never tell them to widen a guard (`gh auth refresh -s workflow`) as the
  fix. If it's an option, say what it gives up.
- If the message is built in code, make it a pure function and test that the
  commands in it actually work (see `heldWorkflowComment` in `src/git.ts` and
  its test in `src/merge.test.ts`, which runs the block's `git apply`).
- Long payloads: mind GitHub's 65,536-character comment limit.

## Existing hand-overs (keep them to this standard)

- `git.heldWorkflowComment()`: a workflow edit pr-daemon couldn't push.
- `handOver()` in `pipeline.ts` `merge`: a conflict that's the human's.
- `viaGitHub()` failure in `pipeline.ts`: GitHub's Update branch didn't work.
- `git.push()` error text, `doctor` output, `gh.ts` scope hints.
