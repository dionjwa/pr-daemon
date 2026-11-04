import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeToken } from "./agent.ts";

test("the claude-token file can hold the bare token or the line setup-token prints", () => {
  const t = "sk-ant-oat01-abcDEF_123-xyz";
  assert.equal(parseClaudeToken(`${t}\n`), t);
  assert.equal(parseClaudeToken(`CLAUDE_CODE_OAUTH_TOKEN=${t}\n`), t);
  assert.equal(parseClaudeToken(`export CLAUDE_CODE_OAUTH_TOKEN="${t}"\n`), t);
  assert.equal(parseClaudeToken(`CLAUDE_CODE_OAUTH_TOKEN=${t.slice(0, 10)}\n${t.slice(10)}\n`), t);  // wrapped by the terminal
  assert.equal(parseClaudeToken("\n"), "");
});
