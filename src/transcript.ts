// An agent's stream-json log, turned into a transcript for the status page:
// what it said, each tool call with its input, and what came back. Pure, so
// it's unit-tested. Thinking blocks arrive with their text left out in
// headless mode, so there's nothing to show for them.

export type Entry =
  | { k: "start"; at: number; prompt: string; resume: boolean }
  | { k: "init"; model: string; session: string }
  | { k: "text"; text: string; sub: boolean }
  | { k: "thinking"; text: string; sub: boolean }
  | { k: "tool"; id: string; name: string; input: string; sub: boolean }
  | { k: "result"; id: string; text: string; error: boolean; sub: boolean }
  | { k: "end"; text: string; error: boolean; turns: number; cost: number };

/** Long tool output is cut to this many characters (head and tail kept). */
export const MAX_RESULT = 4000;

function clip(s: string, max = MAX_RESULT): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n… ${s.length - max} characters left out …\n${s.slice(-half)}`;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((c) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
}

/** The field that says what a call does (a command, a path) first, then the rest as JSON. */
function toolInput(input: Record<string, unknown>): string {
  const k = ["command", "file_path", "pattern", "url", "query"].find((key) => typeof input[key] === "string");
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== k));
  const extra = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "";
  return clip(k ? [String(input[k]), extra].filter(Boolean).join("\n") : extra);
}

export function parseTranscript(text: string): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();   // an assistant message can repeat a block: show it once
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { continue; }
    const sub = !!m.parent_tool_use_id;
    if (m.type === "pr-daemon" && m.subtype === "start") {
      out.push({ k: "start", at: Number(m.at ?? 0), prompt: String(m.prompt ?? ""), resume: !!m.resume });
    } else if (m.type === "system" && m.subtype === "init") {
      out.push({ k: "init", model: String(m.model ?? ""), session: String(m.session_id ?? "") });
    } else if (m.type === "assistant") {
      const content = m.message?.content ?? [];
      content.forEach((c: Record<string, any>, i: number) => {
        const key = `${m.message?.id}:${c.id ?? i}:${c.type}:${c.text ?? c.thinking ?? ""}`.slice(0, 400);
        if (seen.has(key)) return;
        seen.add(key);
        if (c.type === "text" && c.text?.trim()) out.push({ k: "text", text: c.text, sub });
        else if (c.type === "thinking" && c.thinking?.trim()) out.push({ k: "thinking", text: c.thinking, sub });
        else if (c.type === "tool_use") out.push({ k: "tool", id: String(c.id), name: String(c.name), input: toolInput(c.input ?? {}), sub });
      });
    } else if (m.type === "user") {
      for (const c of m.message?.content ?? []) {
        if (c?.type === "tool_result") out.push({ k: "result", id: String(c.tool_use_id), text: clip(resultText(c.content)), error: !!c.is_error, sub });
      }
    } else if (m.type === "result") {
      out.push({ k: "end", text: String(m.result ?? m.subtype ?? ""), error: !!m.is_error, turns: Number(m.num_turns ?? 0), cost: Number(m.total_cost_usd ?? 0) });
    }
  }
  return out;
}
