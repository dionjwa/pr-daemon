import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeToken, stderrError } from "./agent.ts";

test("the claude-token file can hold the bare token or the line setup-token prints", () => {
  const t = "sk-ant-oat01-abcDEF_123-xyz";
  assert.equal(parseClaudeToken(`${t}\n`), t);
  assert.equal(parseClaudeToken(`CLAUDE_CODE_OAUTH_TOKEN=${t}\n`), t);
  assert.equal(parseClaudeToken(`export CLAUDE_CODE_OAUTH_TOKEN="${t}"\n`), t);
  assert.equal(parseClaudeToken(`CLAUDE_CODE_OAUTH_TOKEN=${t.slice(0, 10)}\n${t.slice(10)}\n`), t);  // wrapped by the terminal
  assert.equal(parseClaudeToken("\n"), "");
});

test("stderrError drops the workspace-trust warning and keeps the real error", () => {
  const trust = `Ignoring 33 permissions.allow entries from .claude/settings.local.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/x"].hasTrustDialogAccepted: true in /y/.claude.json.`;
  assert.equal(stderrError(`${trust}\n`), "");
  assert.equal(stderrError(`${trust}\nNo conversation found with session ID: abc\n`), "No conversation found with session ID: abc");
});
