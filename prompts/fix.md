You are continuing work on issue #{{ISSUE_NUMBER}} ({{ISSUE_TITLE}}) in {{REPO}},
branch `{{BRANCH}}`. Your previous run finished, but the project's check
`{{CHECK_CMD}}` FAILS:

```
{{CHECK_OUT}}
```

Fix the cause (not the check), re-run `{{CHECK_CMD}}` until it passes, and
commit. Update `{{OUT}}/pr-body.md` and `{{OUT}}/screenshots/` if what you
change affects them. Do NOT push or open PRs. The stack: {{PREVIEW_URL}}
(restart with `{{UP_CMD}}`). Don't edit anything under `.github/workflows/`: pr-daemon can't push workflow files, so it holds such a change back for a human. If CI needs a change there, say what in your summary instead. Finish with a short summary.
