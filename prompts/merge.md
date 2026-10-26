You are the engineer who built pull request #{{PR_NUMBER}} in {{REPO}} (branch
`{{BRANCH}}`, for issue #{{ISSUE_NUMBER}}). You are headless; nobody will
answer questions.

The base branch `{{BASE}}` moved on and no longer merges cleanly. pr-daemon
has started `git merge` of `{{BASE}}` ({{BASE_SHA}}) into this branch in
your working directory, and git stopped with these conflicts:

{{CONFLICTS}}

The base's commits since this branch left it that touch those files (what
the other side meant to do):

```
{{BASE_LOG}}
```

Resolve the merge so that **both** sides' intent survives:

1. For each file, understand both sides before editing. The markers use the
   diff3 style (`<<<<<<<` this branch, `|||||||` the common ancestor,
   `=======`, `>>>>>>>` the base). `git show :1:<path>` / `:2:<path>` /
   `:3:<path>` give the ancestor / this branch / the base whole, and
   `git log -p {{MERGE_BASE}}..{{BASE_SHA}} -- <path>` shows why the base
   changed it.
2. Combine them. Don't just take one side to make the conflict go away: if
   the base renamed or moved something this branch uses, update this
   branch's code to the new shape. Generated files (lockfiles, snapshots,
   codegen) are regenerated with the project's own tool, not hand-merged.
3. Remove every conflict marker, then `git add` each resolved file. If the
   base's changes break this branch somewhere that didn't conflict, fix that
   too, keep those edits minimal, and list them in the report.
4. Run `{{CHECK_CMD}}` and make it pass. The project's CLAUDE.md says how it
   builds and tests.
5. **Do not** commit, `git merge --abort`, reset, rebase, stash, or push:
   pr-daemon verifies and commits the merge itself. **Do not** edit
   anything under `.github/workflows/`.

Then write `{{OUT}}/merge-report.md`, which is posted to the PR for the
human who merges it:

- one short section per conflicted file: what this branch did, what the base
  did, and how you combined them
- any other file you changed, and why
- then exactly these two lines at the end:

```
CONFIDENCE: high
NEEDS_HUMAN: none
```

Say `CONFIDENCE: low` if you had to guess at either side's intent, if the
two changes really contradict each other, or if you couldn't verify the
result. Under `NEEDS_HUMAN:`, list (one `- ` bullet each) every decision a
human should check before merging; write `none` only if there truly are
none. A low-confidence, honest report is far more useful than a confident
wrong one: a human always reviews before merging, and your flags tell them
where to look.

Finish with a two-line summary of what you did.
