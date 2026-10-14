You are continuing work on issue #{{ISSUE_NUMBER}} ({{ISSUE_TITLE}}) in {{REPO}},
branch `{{BRANCH}}`. Your previous run finished, but the project's check
`{{CHECK_CMD}}` FAILS:

```
{{CHECK_OUT}}
```

Fix the cause (not the check), re-run `{{CHECK_CMD}}` until it passes, and
commit. Update `{{OUT}}/pr-body.md` and `{{OUT}}/screenshots/` if what you
change affects them. Do NOT push or open PRs. The stack: {{PREVIEW_URL}}
(restart with `{{UP_CMD}}`). Finish with a short summary.
