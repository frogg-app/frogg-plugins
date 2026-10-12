import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginContext, PluginTodo } from "@frogg/plugin-api";
import { parseConfig } from "../src/config.ts";
import { TODO_HEADER } from "../src/format.ts";
import type { DriveComment, GoogleClient } from "../src/google.ts";
import { StateFile } from "../src/state.ts";
import { GoogleSync } from "../src/sync.ts";

type Call = { op: string; args: unknown[] };

function fakeGoogle() {
  const calls: Call[] = [];
  let n = 0;
  const comments: Record<string, DriveComment[]> = {};
  const sheets: Record<string, string[][]> = {};
  const google = {
    calls,
    comments,
    sheets,
    fileExists: async () => true,
    ensureFolder: async (name: string) => (calls.push({ op: "folder", args: [name] }), `folder-${name}`),
    createFile: async (name: string, mime: string) => {
      calls.push({ op: "create", args: [name, mime] });
      return `file-${++n}`;
    },
    sheetsBatchUpdate: async () => undefined,
    batchUpdateValues: async (id: string, data: { range: string; values: unknown[][] }[]) => {
      calls.push({ op: "values", args: [id, data] });
    },
    getValues: async (id: string) => sheets[id] ?? [],
    clearValues: async () => undefined,
    docEndIndex: async () => 1,
    docsBatchUpdate: async (id: string, requests: unknown[]) => {
      calls.push({ op: "docs", args: [id, requests.length] });
    },
    listComments: async (id: string) => comments[id] ?? [],
    replyToComment: async (id: string, commentId: string, content: string) => {
      calls.push({ op: "reply", args: [id, commentId, content] });
    },
    getPresentation: async () => ({ slides: [{ objectId: "p1" }] }),
    slidesBatchUpdate: async (id: string, requests: unknown[]) => {
      calls.push({ op: "slides", args: [id, requests.length] });
    },
  };
  return google;
}

function fakeCtx(remote: { on: boolean }) {
  const sent: { agentId: string; text: string; actor?: string }[] = [];
  const statusSet: string[] = [];
  let todos: PluginTodo[] = [
    {
      id: "t1",
      projectId: "p1",
      title: "Write docs",
      description: "",
      category: null,
      priority: "medium",
      status: "ready",
      claimedBy: [],
      progressCount: 0,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    },
  ];
  const agent = {
    id: "agent-1",
    provider: "claude",
    cwd: "/w",
    status: "idle",
    title: "Fix login",
    workspaceId: "w1",
    updatedAt: new Date().toISOString(),
  };
  const ctx = {
    log: { info() {}, warn() {}, debug() {}, error() {} },
    host: {
      get remoteControl() {
        return remote.on;
      },
    },
    agents: {
      get: async () => agent,
      list: async () => [agent],
      getDiffStat: async () => ({ additions: 4, deletions: 1 }),
      getTimeline: async () => ({
        entries: [{ seq: 1, timestamp: "", item: { type: "plan", text: "1. Do it" } }],
        cursor: "e:1",
        reset: false,
        hasMore: false,
      }),
      getLastAssistantMessage: async () => "All fixed.",
      sendMessage: async (agentId: string, text: string, o?: { actor?: string }) => {
        sent.push({ agentId, text, actor: o?.actor });
      },
    },
    workspaces: {
      get: async () => ({ id: "w1", projectId: "p1", title: "app", cwd: "/w", branch: "main", kind: "worktree" }),
      listProjects: async () => [{ id: "p1", name: "App", rootPath: "/w" }],
    },
    todos: {
      list: async () => todos,
      setStatus: async (_p: string, id: string, status: string) => {
        statusSet.push(`${id}:${status}`);
        todos = todos.map((t) => (t.id === id ? { ...t, status } : t));
      },
      create: async () => undefined,
      update: async () => undefined,
    },
  } as unknown as PluginContext;
  return { ctx, sent, statusSet };
}

async function setup(remoteOn: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "gw-sync-"));
  const state = new StateFile(dir);
  await state.load();
  const google = fakeGoogle();
  const remote = { on: remoteOn };
  const { ctx, sent, statusSet } = fakeCtx(remote);
  const sync = new GoogleSync({
    ctx,
    google: google as unknown as GoogleClient,
    state,
    config: () => parseConfig({ clientId: "c", clientSecret: "s" }),
    connectedEmail: () => "me@x.com",
  });
  return { sync, google, state, sent, statusSet, remote };
}

test("finished agents get a report doc and a ledger row", async () => {
  const { sync, google, state } = await setup(true);
  await sync.onAgentFinished("agent-1", "finished", "All fixed.");
  sync.dispose();
  await sync.flushLedger();
  const docId = state.value.reports["agent-1"];
  assert.ok(docId);
  assert.equal(state.value.docs[docId]!.kind, "report");
  assert.ok(google.calls.some((c) => c.op === "create" && c.args[0] === "Frogg report — Fix login"));
  assert.ok(google.calls.some((c) => c.op === "create" && c.args[0] === "Frogg agent ledger"));
  const ledgerWrite = google.calls.filter((c) => c.op === "values").pop()!;
  const data = ledgerWrite.args[1] as { range: string; values: unknown[][] }[];
  assert.equal(data[0]!.range, "Agents!A2:O2");
  assert.equal(data[0]!.values[0]![0], "agent-1");
  assert.equal(data[0]!.values[0]![14], `https://docs.google.com/document/d/${docId}/edit`);
});

test("@frogg comments reach the agent and the answer is replied", async () => {
  const { sync, google, state, sent } = await setup(true);
  await sync.exportReport("agent-1");
  const docId = state.value.reports["agent-1"]!;
  google.comments[docId] = [
    { id: "c1", content: "@frogg add a test", author: { me: true }, createdTime: "", modifiedTime: "" },
    { id: "c2", content: "@frogg do evil", author: { emailAddress: "evil@x.com" }, createdTime: "", modifiedTime: "" },
    { id: "c3", content: "nice work", author: { me: true }, createdTime: "", modifiedTime: "" },
  ];
  await sync.pollComments();
  await sync.pollComments(); // handled comments are not resent
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /add a test/);
  assert.equal(sent[0]!.actor, "google:me@x.com");
  const replies = new Map(google.calls.filter((c) => c.op === "reply").map((c) => [c.args[1], String(c.args[2])]));
  assert.match(replies.get("c1")!, /Sent to the agent/);
  assert.match(replies.get("c2")!, /not on the plugin's list/);
  assert.equal(replies.has("c3"), false);
  await sync.onAgentFinished("agent-1", "finished", "Added the test.");
  sync.dispose();
  const answer = google.calls.filter((c) => c.op === "reply").pop()!;
  assert.deepEqual(answer.args.slice(0, 2), [docId, "c1"]);
  assert.equal(answer.args[2], "Added the test.");
  assert.equal(state.value.pendingReplies.length, 0);
});

test("comments are refused while remote control is off", async () => {
  const { sync, google, state, sent } = await setup(false);
  await sync.exportReport("agent-1");
  const docId = state.value.reports["agent-1"]!;
  google.comments[docId] = [{ id: "c1", content: "@frogg go", author: { me: true }, createdTime: "", modifiedTime: "" }];
  await sync.pollComments();
  sync.dispose();
  assert.equal(sent.length, 0);
  assert.match(String(google.calls.filter((c) => c.op === "reply")[0]!.args[2]), /remote control is off/);
});

test("to-do sheet: first sync writes rows, later edits change status", async () => {
  const { sync, google, state, statusSet } = await setup(true);
  await sync.syncTodos("p1");
  const sheetId = state.value.todos["p1"]!.spreadsheetId;
  const write = google.calls.filter((c) => c.op === "values").pop()!;
  const rows = (write.args[1] as { values: string[][] }[])[0]!.values;
  assert.deepEqual(rows[0], TODO_HEADER);
  assert.equal(rows[1]![0], "t1");
  google.sheets[sheetId] = [TODO_HEADER, ["t1", "Write docs", "done", "medium", "", "", "", ""]];
  await sync.syncTodos("p1");
  sync.dispose();
  assert.deepEqual(statusSet, ["t1:done"]);
  assert.equal(state.value.todos["p1"]!.snapshot["t1"]!.status, "done");
});

test("plans export to their own doc; decks build slides", async () => {
  const { sync, google, state } = await setup(true);
  const url = await sync.exportPlan("agent-1");
  assert.match(url, /docs.google.com\/document/);
  assert.ok(Object.values(state.value.docs).some((d) => d.kind === "plan"));
  const deckUrl = await sync.createDeck();
  sync.dispose();
  assert.match(deckUrl, /docs.google.com\/presentation/);
  const slides = google.calls.find((c) => c.op === "slides")!;
  // 2 slides × 3 requests + 1 delete of the starter slide
  assert.equal(slides.args[1], 7);
});
