import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentSummary, PluginTodo } from "@frogg/plugin-api";
import {
  buildReport,
  commandFromComment,
  deckRequests,
  diffTodoSheet,
  docRequests,
  ledgerRow,
  todoFields,
  TODO_HEADER,
  todoRow,
} from "../src/format.ts";

const agent: PluginAgentSummary = {
  id: "a1b2c3d4e5",
  provider: "claude",
  cwd: "/w",
  status: "idle",
  title: "Fix login",
  model: "opus",
  branch: "fix/login",
  prUrl: "https://github.com/x/y/pull/1",
  usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.123456 },
  createdAt: "2026-10-12T10:00:00Z",
  updatedAt: "2026-10-12T11:00:00Z",
};

function todo(id: string, over: Partial<PluginTodo> = {}): PluginTodo {
  return {
    id,
    projectId: "p",
    title: `T ${id}`,
    description: "",
    category: null,
    priority: "medium",
    status: "ready",
    claimedBy: [],
    progressCount: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

test("ledger rows carry usage, diff and links", () => {
  const row = ledgerRow(agent, { additions: 5, deletions: 2 }, "https://docs/r");
  assert.equal(row[0], "a1b2c3d4e5");
  assert.equal(row[10], 0.1235);
  assert.deepEqual(row.slice(11), [5, 2, "https://github.com/x/y/pull/1", "https://docs/r"]);
});

test("doc requests insert once and style computed ranges", () => {
  const reqs = docRequests([
    { text: "Title", style: "TITLE" },
    { text: "point", style: "NORMAL_TEXT", bullet: true, link: "https://x" },
  ]) as Record<string, any>[];
  assert.equal(reqs[0].insertText.text, "Title\npoint\n");
  assert.deepEqual(reqs[1].updateParagraphStyle.range, { startIndex: 1, endIndex: 7 });
  assert.deepEqual(reqs[2].updateParagraphStyle.range, { startIndex: 7, endIndex: 13 });
  assert.ok(reqs.some((r) => r.createParagraphBullets));
  const link = reqs.find((r) => r.updateTextStyle)!;
  assert.deepEqual(link.updateTextStyle.range, { startIndex: 7, endIndex: 12 });
});

test("reports summarize steps, files and plan", () => {
  const { title, blocks } = buildReport({
    agent,
    workspaceTitle: "app",
    diff: { additions: 1, deletions: 0 },
    answer: "Done.",
    now: new Date("2026-10-12T12:00:00Z"),
    entries: [
      { seq: 1, timestamp: "", item: { type: "tool_call", callId: "c", name: "Edit", status: "completed", summary: "src/a.ts" } },
      { seq: 2, timestamp: "", item: { type: "tool_call", callId: "d", name: "Bash", status: "failed", summary: "npm test" } },
      { seq: 3, timestamp: "", item: { type: "plan", text: "1. fix" } },
    ],
  });
  assert.equal(title, "Frogg report — Fix login");
  const texts = blocks.map((b) => b.text);
  assert.ok(texts.includes("src/a.ts"));
  assert.ok(texts.includes("Bash: npm test (failed)"));
  assert.ok(texts.includes("1. fix"));
  assert.ok(texts.includes("Done."));
});

test("only @frogg comments are commands", () => {
  assert.equal(commandFromComment("@frogg please add tests"), "please add tests");
  assert.equal(commandFromComment("  @Frogg: approved"), "approved");
  assert.equal(commandFromComment("@froggy hi"), null);
  assert.equal(commandFromComment("looks good"), null);
  assert.equal(commandFromComment("@frogg"), null);
});

test("sheet edits become to-do ops; Frogg wins conflicts", () => {
  const a = todo("a");
  const b = todo("b", { title: "Changed in Frogg" });
  const snapshot = { a: todoFields(a), b: todoFields(todo("b")) };
  const rows = [
    TODO_HEADER,
    ["a", "New title", "Done", "HIGH", "", "", "", ""],
    ["b", "Sheet title", "ready", "medium", "", "", "", ""],
    ["", "Brand new", "backlog", "low", "ops", "desc", "", ""],
    ["", "", "", "", "", "", "", ""],
  ];
  const ops = diffTodoSheet(rows, snapshot, [a, b]);
  assert.deepEqual(ops, [
    { kind: "update", todoId: "a", patch: { title: "New title", priority: "high" } },
    { kind: "status", todoId: "a", status: "done" },
    { kind: "create", fields: { title: "Brand new", status: "backlog", priority: "low", category: "ops", description: "desc" } },
  ]);
});

test("claim-bound and unknown statuses are rejected", () => {
  const a = todo("a");
  const ops = diffTodoSheet([TODO_HEADER, ["a", "T a", "in progress", "medium", "", "", "", ""]], { a: todoFields(a) }, [a]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, "rejected");
  const ops2 = diffTodoSheet([TODO_HEADER, ["a", "T a", "nope", "medium", "", "", "", ""]], { a: todoFields(a) }, [a]);
  assert.match((ops2[0] as { reason: string }).reason, /Unknown status/);
});

test("todo rows list live claims only", () => {
  const row = todoRow(todo("a", { claimedBy: [{ agentId: "abcdefghij", stale: false }, { agentId: "zzzzzzzzzz", stale: true }] }));
  assert.equal(row[6], "abcdefgh");
});

test("deck requests map placeholders per slide", () => {
  const reqs = deckRequests("Deck", "sub", [{ title: "One", body: "b" }]) as Record<string, any>[];
  const slides = reqs.filter((r) => r.createSlide);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].createSlide.slideLayoutReference.predefinedLayout, "TITLE");
  assert.equal(slides[1].createSlide.placeholderIdMappings[1].objectId, "frogg_s1_b");
});
