// Pure builders: ledger rows, Doc content and its batchUpdate requests, the to-do Sheet and its
// two-way diff, and Slides requests. No I/O here, so all of it is unit-tested.
import type {
  PluginAgentSummary,
  PluginDiffStat,
  PluginTimelineEntry,
  PluginTodo,
} from "@frogg/plugin-api";

// ------------------------------------------------------------------ ledger

export const LEDGER_SHEET = "Agents";
export const LEDGER_HEADER = [
  "Agent ID",
  "Title",
  "Status",
  "Provider",
  "Model",
  "Branch",
  "Started",
  "Updated",
  "Input tokens",
  "Output tokens",
  "Cost (USD)",
  "Lines +",
  "Lines −",
  "Pull request",
  "Report",
];

export function ledgerRow(
  agent: PluginAgentSummary,
  diff: PluginDiffStat | null,
  reportUrl: string | null,
): (string | number)[] {
  const usage = agent.usage ?? null;
  return [
    agent.id,
    agent.title ?? "",
    agent.status,
    agent.provider,
    agent.model ?? "",
    agent.branch ?? "",
    agent.createdAt ?? "",
    agent.updatedAt ?? "",
    usage?.inputTokens ?? "",
    usage?.outputTokens ?? "",
    usage?.costUsd !== undefined ? Number(usage.costUsd.toFixed(4)) : "",
    diff?.additions ?? "",
    diff?.deletions ?? "",
    agent.prUrl ?? "",
    reportUrl ?? "",
  ];
}

/** Last column letter for a row of `n` cells (n ≤ 26). */
export function columnLetter(n: number): string {
  return String.fromCharCode(64 + n);
}

// -------------------------------------------------------------------- docs

export type DocStyle = "TITLE" | "HEADING_1" | "HEADING_2" | "NORMAL_TEXT";

export interface DocBlock {
  text: string;
  style: DocStyle;
  bullet?: boolean;
  link?: string;
}

/** Strips characters the Docs API refuses and normalizes newlines. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/**
 * Requests that write `blocks` into an empty document body (index 1). Text goes in first as one
 * insert, then paragraph styles, bullets and links are applied over the computed ranges.
 */
export function docRequests(blocks: DocBlock[]): unknown[] {
  let text = "";
  const ranges: { start: number; end: number; block: DocBlock }[] = [];
  for (const block of blocks) {
    const body = clean(block.text).replace(/\n+$/, "") || " ";
    const start = 1 + text.length;
    text += `${body}\n`;
    ranges.push({ start, end: 1 + text.length, block });
  }
  if (!text) return [];
  const requests: unknown[] = [{ insertText: { location: { index: 1 }, text } }];
  for (const { start, end, block } of ranges) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: { namedStyleType: block.style },
        fields: "namedStyleType",
      },
    });
    if (block.bullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: end },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }
    if (block.link) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end - 1 },
          textStyle: { link: { url: block.link } },
          fields: "link",
        },
      });
    }
  }
  return requests;
}

/** Requests that empty a document whose body ends at `endIndex`. */
export function clearDocRequests(endIndex: number): unknown[] {
  return endIndex > 2
    ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }]
    : [];
}

const MAX_STEPS = 40;
const MAX_ANSWER = 30_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function agentTitle(agent: PluginAgentSummary): string {
  return agent.title?.trim() || `Agent ${agent.id.slice(0, 8)}`;
}

/** Tool steps, files touched and the latest plan, derived from timeline entries. */
export function summarizeTimeline(entries: PluginTimelineEntry[]): {
  steps: string[];
  files: string[];
  plan: string | null;
} {
  const steps: string[] = [];
  const files = new Set<string>();
  let plan: string | null = null;
  for (const { item } of entries) {
    if (item.type === "tool_call" && item.status !== "running") {
      const gist = item.summary ? `${item.name}: ${item.summary}` : item.name;
      steps.push(item.status === "failed" ? `${gist} (failed)` : gist);
      if (item.summary && /^(edit|write|multiedit|apply_patch|str_replace)/i.test(item.name))
        files.add(item.summary);
    } else if (item.type === "plan") {
      plan = item.text;
    }
  }
  return { steps: steps.slice(-MAX_STEPS), files: [...files].sort(), plan };
}

export interface ReportInput {
  agent: PluginAgentSummary;
  workspaceTitle: string | null;
  diff: PluginDiffStat | null;
  answer: string | null;
  entries: PluginTimelineEntry[];
  now: Date;
}

export function buildReport(input: ReportInput): { title: string; blocks: DocBlock[] } {
  const { agent, diff, answer } = input;
  const title = `Frogg report — ${agentTitle(agent)}`;
  const { steps, files, plan } = summarizeTimeline(input.entries);
  const facts: DocBlock[] = [
    `Status: ${agent.status}${agent.lastError ? ` (${agent.lastError})` : ""}`,
    `Agent: ${agent.provider}${agent.model ? ` · ${agent.model}` : ""}`,
    ...(input.workspaceTitle ? [`Workspace: ${input.workspaceTitle}`] : []),
    ...(agent.branch ? [`Branch: ${agent.branch}`] : []),
    ...(diff ? [`Changes: +${diff.additions} −${diff.deletions} lines`] : []),
    ...(agent.usage?.costUsd !== undefined ? [`Cost: $${agent.usage.costUsd.toFixed(2)}`] : []),
    `Updated: ${input.now.toISOString().replace("T", " ").slice(0, 16)} UTC`,
  ].map((text) => ({ text, style: "NORMAL_TEXT" as const, bullet: true }));
  if (agent.prUrl)
    facts.push({ text: `Pull request: ${agent.prUrl}`, style: "NORMAL_TEXT", bullet: true, link: agent.prUrl });

  const blocks: DocBlock[] = [
    { text: title, style: "TITLE" },
    { text: "Summary", style: "HEADING_1" },
    ...facts,
    { text: "Final answer", style: "HEADING_1" },
    { text: truncate(answer?.trim() || "No answer yet.", MAX_ANSWER), style: "NORMAL_TEXT" },
  ];
  if (plan) blocks.push({ text: "Plan", style: "HEADING_1" }, { text: truncate(plan, MAX_ANSWER), style: "NORMAL_TEXT" });
  if (files.length) {
    blocks.push({ text: "Files changed", style: "HEADING_1" });
    for (const f of files) blocks.push({ text: f, style: "NORMAL_TEXT", bullet: true });
  }
  if (steps.length) {
    blocks.push({ text: "What it did", style: "HEADING_1" });
    for (const s of steps) blocks.push({ text: truncate(s, 300), style: "NORMAL_TEXT", bullet: true });
  }
  blocks.push(
    { text: "Talk to this agent", style: "HEADING_2" },
    {
      text: "Add a comment that starts with @frogg and it goes to this agent; the answer is posted as a reply.",
      style: "NORMAL_TEXT",
    },
  );
  return { title, blocks };
}

export function buildPlanDoc(agent: PluginAgentSummary, plan: string): { title: string; blocks: DocBlock[] } {
  const title = `Plan — ${agentTitle(agent)}`;
  return {
    title,
    blocks: [
      { text: title, style: "TITLE" },
      {
        text: "Review this plan. Comment with @frogg to send feedback or approval to the agent.",
        style: "NORMAL_TEXT",
      },
      { text: "Plan", style: "HEADING_1" },
      { text: truncate(plan, MAX_ANSWER), style: "NORMAL_TEXT" },
    ],
  };
}

/** The message text of an @frogg comment, or null when the comment is not addressed to Frogg. */
export function commandFromComment(content: string): string | null {
  const m = /^\s*@frogg\b[:,]?\s*([\s\S]*)$/i.exec(content);
  if (!m) return null;
  const text = m[1]!.trim();
  return text || null;
}

// ------------------------------------------------------------------- to-dos

export const TODO_SHEET = "To-dos";
export const TODO_HEADER = ["ID", "Title", "Status", "Priority", "Category", "Description", "Claimed by", "Updated"];
const TODO_STATUSES = new Set(["backlog", "ready", "claimed", "in_progress", "review", "done", "blocked"]);
const SETTABLE_STATUSES = new Set(["backlog", "ready", "review", "done", "blocked"]);
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

/** The fields that round-trip through the Sheet. */
export interface TodoFields {
  title: string;
  status: string;
  priority: string;
  category: string;
  description: string;
}

export function todoFields(todo: PluginTodo): TodoFields {
  return {
    title: todo.title,
    status: todo.status,
    priority: todo.priority,
    category: todo.category ?? "",
    description: todo.description,
  };
}

export function todoRow(todo: PluginTodo): string[] {
  const f = todoFields(todo);
  return [
    todo.id,
    f.title,
    f.status,
    f.priority,
    f.category,
    f.description,
    todo.claimedBy.filter((c) => !c.stale).map((c) => c.agentId.slice(0, 8)).join(", "),
    todo.updatedAt,
  ];
}

function rowFields(row: string[]): TodoFields {
  const cell = (i: number) => (row[i] ?? "").trim();
  return {
    title: cell(1),
    status: cell(2).toLowerCase().replace(/[\s-]+/g, "_"),
    priority: cell(3).toLowerCase(),
    category: cell(4),
    description: row[5] ?? "",
  };
}

export type TodoOp =
  | { kind: "create"; fields: TodoFields }
  | { kind: "update"; todoId: string; patch: Partial<Omit<TodoFields, "status">> }
  | { kind: "status"; todoId: string; status: string }
  | { kind: "rejected"; todoId: string | null; reason: string };

/**
 * Sheet edits since the last sync, as to-do operations. A field changed in the Sheet is applied
 * only if Frogg still holds the value from the last sync; when both sides changed it, Frogg wins
 * and the next write puts Frogg's value back. Rows without an ID and with a title become new
 * to-dos. Deleted rows are ignored: deleting from a spreadsheet is too easy to do by accident.
 */
export function diffTodoSheet(
  rows: string[][],
  snapshot: Record<string, TodoFields>,
  todos: PluginTodo[],
): TodoOp[] {
  const ops: TodoOp[] = [];
  const byId = new Map(todos.map((t) => [t.id, t]));
  for (const row of rows.slice(1)) {
    const id = (row[0] ?? "").trim();
    const sheet = rowFields(row);
    if (!id) {
      if (!sheet.title) continue;
      ops.push({ kind: "create", fields: sheet });
      continue;
    }
    const todo = byId.get(id);
    const last = snapshot[id];
    if (!todo || !last) continue;
    const current = todoFields(todo);
    const patch: Partial<Omit<TodoFields, "status">> = {};
    for (const key of ["title", "priority", "category", "description"] as const) {
      if (sheet[key] === last[key] || current[key] !== last[key]) continue;
      if (key === "title" && !sheet.title) continue;
      if (key === "priority" && !PRIORITIES.has(sheet.priority)) {
        ops.push({ kind: "rejected", todoId: id, reason: `Unknown priority "${sheet.priority}"` });
        continue;
      }
      patch[key] = sheet[key];
    }
    if (Object.keys(patch).length) ops.push({ kind: "update", todoId: id, patch });
    if (sheet.status !== last.status && current.status === last.status) {
      if (SETTABLE_STATUSES.has(sheet.status)) ops.push({ kind: "status", todoId: id, status: sheet.status });
      else
        ops.push({
          kind: "rejected",
          todoId: id,
          reason: TODO_STATUSES.has(sheet.status)
            ? `"${sheet.status}" follows agent claims and can't be set from the Sheet`
            : `Unknown status "${sheet.status}"`,
        });
    }
  }
  return ops;
}

export function validPriority(value: string): string | undefined {
  return PRIORITIES.has(value) ? value : undefined;
}

// ------------------------------------------------------------------ slides

export interface DeckSlide {
  title: string;
  body: string;
}

/** Requests that add one TITLE slide and then a TITLE_AND_BODY slide per entry. */
export function deckRequests(deckTitle: string, subtitle: string, slides: DeckSlide[]): unknown[] {
  const requests: unknown[] = [];
  const add = (i: number, layout: string, title: string, body: string, bodyType: string) => {
    const id = `frogg_s${i}`;
    requests.push(
      {
        createSlide: {
          objectId: id,
          insertionIndex: i,
          slideLayoutReference: { predefinedLayout: layout },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: layout === "TITLE" ? "CENTERED_TITLE" : "TITLE" }, objectId: `${id}_t` },
            { layoutPlaceholder: { type: bodyType }, objectId: `${id}_b` },
          ],
        },
      },
      { insertText: { objectId: `${id}_t`, text: title || " " } },
      { insertText: { objectId: `${id}_b`, text: body || " " } },
    );
  };
  add(0, "TITLE", deckTitle, subtitle, "SUBTITLE");
  slides.forEach((s, i) => add(i + 1, "TITLE_AND_BODY", truncate(s.title, 120), truncate(s.body, 1200), "BODY"));
  return requests;
}

/** Up to three short lines from an answer, for a slide body. */
export function answerGist(answer: string | null): string {
  if (!answer) return "";
  return answer
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("```"))
    .slice(0, 3)
    .map((l) => truncate(l, 200))
    .join("\n");
}
