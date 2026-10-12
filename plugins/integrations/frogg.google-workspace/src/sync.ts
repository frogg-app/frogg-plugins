// The sync engine: Frogg → Google (ledger rows, report and plan Docs, to-do Sheets, decks) and
// Google → Frogg (Sheet edits to to-dos, @frogg Doc comments to agents, answers back as replies).
import type { PluginAgentSummary, PluginContext, PluginTodo } from "@frogg/plugin-api";
import { isAllowedGoogleUser, type GoogleConfig } from "./config.ts";
import {
  LEDGER_HEADER,
  LEDGER_SHEET,
  TODO_HEADER,
  TODO_SHEET,
  agentTitle,
  answerGist,
  buildPlanDoc,
  buildReport,
  clearDocRequests,
  columnLetter,
  commandFromComment,
  deckRequests,
  diffTodoSheet,
  docRequests,
  ledgerRow,
  summarizeTimeline,
  todoFields,
  todoRow,
  validPriority,
  type DocBlock,
} from "./format.ts";
import { GoogleApiError, MIME, fileUrl, type GoogleClient } from "./google.ts";
import type { StateFile } from "./state.ts";

const LEDGER_LAST_COL = columnLetter(LEDGER_HEADER.length);
const TODO_LAST_COL = columnLetter(TODO_HEADER.length);
const MAX_REPLY = 8000;

export interface SyncDeps {
  ctx: PluginContext;
  google: GoogleClient;
  state: StateFile;
  config: () => GoogleConfig;
  connectedEmail: () => string | null;
  now?: () => Date;
}

export class GoogleSync {
  private readonly ledgerDirty = new Set<string>();
  private readonly todoDirty = new Set<string>();
  private ledgerTimer: NodeJS.Timeout | null = null;
  private todoTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  lastError: string | null = null;
  lastSyncAt: string | null = null;
  readonly notices: string[] = [];

  private readonly deps: SyncDeps;
  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  private get ctx(): PluginContext {
    return this.deps.ctx;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Serializes Google work so writes to one file never interleave. */
  private run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => {
        this.lastError = null;
        this.lastSyncAt = this.now().toISOString();
      },
      (err) => {
        this.lastError = `${what}: ${err instanceof Error ? err.message : String(err)}`;
        this.ctx.log.warn(`google ${what} failed`, { error: this.lastError });
      },
    );
    return next;
  }

  private notice(text: string): void {
    this.notices.unshift(`${this.now().toISOString().slice(11, 16)} ${text}`);
    this.notices.length = Math.min(this.notices.length, 8);
  }

  dispose(): void {
    if (this.ledgerTimer) clearTimeout(this.ledgerTimer);
    if (this.todoTimer) clearTimeout(this.todoTimer);
  }

  // ---------------------------------------------------------------- folders

  private async rootFolder(): Promise<string> {
    const { state, google } = this.deps;
    const known = state.value.rootFolderId;
    if (known && (await google.fileExists(known))) return known;
    const id = await google.ensureFolder(this.deps.config().folderName, null);
    await state.save((s) => {
      s.rootFolderId = id;
    });
    return id;
  }

  private async projectFolder(projectId: string | null, name: string | null): Promise<string> {
    const root = await this.rootFolder();
    if (!projectId) return root;
    const { state, google } = this.deps;
    const known = state.value.projectFolders[projectId];
    if (known && (await google.fileExists(known))) return known;
    const id = await google.ensureFolder(name || projectId, root);
    await state.save((s) => {
      s.projectFolders[projectId] = id;
    });
    return id;
  }

  private async workspaceOf(agent: PluginAgentSummary) {
    if (!agent.workspaceId || !this.ctx.workspaces) return null;
    return this.ctx.workspaces.get(agent.workspaceId).catch(() => null);
  }

  private async projectName(projectId: string): Promise<string | null> {
    const projects = await this.ctx.workspaces?.listProjects().catch(() => []);
    return projects?.find((p) => p.id === projectId)?.name ?? null;
  }

  // ----------------------------------------------------------------- ledger

  markAgent(agentId: string): void {
    if (!this.deps.config().ledger) return;
    this.ledgerDirty.add(agentId);
    this.ledgerTimer ??= setTimeout(() => {
      this.ledgerTimer = null;
      void this.flushLedger().catch(() => undefined);
    }, 5000);
  }

  private async ensureLedger(): Promise<{ spreadsheetId: string; rows: Record<string, number> }> {
    const { state, google } = this.deps;
    const known = state.value.ledger;
    if (known && (await google.fileExists(known.spreadsheetId))) return known;
    const id = await google.createFile("Frogg agent ledger", MIME.sheet, await this.rootFolder());
    await google.sheetsBatchUpdate(id, [
      { updateSheetProperties: { properties: { sheetId: 0, title: LEDGER_SHEET, gridProperties: { frozenRowCount: 1 } }, fields: "title,gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    ]);
    await google.batchUpdateValues(id, [{ range: `${LEDGER_SHEET}!A1:${LEDGER_LAST_COL}1`, values: [LEDGER_HEADER] }]);
    const ledger = { spreadsheetId: id, rows: {} };
    await state.save((s) => {
      s.ledger = ledger;
    });
    this.notice("Created the agent ledger sheet");
    return ledger;
  }

  flushLedger(): Promise<void> {
    const ids = [...this.ledgerDirty];
    this.ledgerDirty.clear();
    if (!ids.length) return Promise.resolve();
    return this.run("ledger", async () => {
      const ledger = await this.ensureLedger();
      const data: { range: string; values: (string | number)[][] }[] = [];
      let nextRow = Math.max(1, ...Object.values(ledger.rows)) + 1;
      const added: Record<string, number> = {};
      for (const id of ids) {
        const agent = await this.ctx.agents.get(id);
        if (!agent) continue;
        const diff = await this.ctx.agents.getDiffStat(id).catch(() => null);
        const report = this.deps.state.value.reports[id];
        const row = ledger.rows[id] ?? added[id] ?? (added[id] = nextRow++);
        data.push({
          range: `${LEDGER_SHEET}!A${row}:${LEDGER_LAST_COL}${row}`,
          values: [ledgerRow(agent, diff, report ? fileUrl.doc(report) : null)],
        });
      }
      await this.deps.google.batchUpdateValues(ledger.spreadsheetId, data);
      if (Object.keys(added).length)
        await this.deps.state.save((s) => {
          if (s.ledger) Object.assign(s.ledger.rows, added);
        });
    });
  }

  // ----------------------------------------------------------- docs common

  private async writeDoc(docId: string | null, title: string, blocks: DocBlock[], folder: string): Promise<string> {
    const { google } = this.deps;
    let id = docId && (await google.fileExists(docId)) ? docId : null;
    if (id) {
      await google.docsBatchUpdate(id, clearDocRequests(await google.docEndIndex(id)));
    } else {
      id = await google.createFile(title, MIME.doc, folder);
    }
    await google.docsBatchUpdate(id, docRequests(blocks));
    return id;
  }

  private async track(docId: string, agentId: string, kind: "report" | "plan", title: string): Promise<void> {
    await this.deps.state.save((s) => {
      const existing = s.docs[docId];
      s.docs[docId] = existing
        ? { ...existing, title }
        : { docId, agentId, kind, title, commentsCheckedAt: this.now().toISOString(), handledComments: [] };
      if (kind === "report") s.reports[agentId] = docId;
    });
  }

  // ---------------------------------------------------------------- reports

  /** Creates or rewrites the agent's report Doc; returns its URL. */
  exportReport(agentId: string): Promise<string> {
    return this.run("report", async () => {
      const agent = await this.ctx.agents.get(agentId);
      if (!agent) throw new Error(`No agent ${agentId}`);
      const [page, answer, diff, workspace] = await Promise.all([
        this.ctx.agents.getTimeline(agentId, { limit: 500 }),
        this.ctx.agents.getLastAssistantMessage(agentId),
        this.ctx.agents.getDiffStat(agentId).catch(() => null),
        this.workspaceOf(agent),
      ]);
      const { title, blocks } = buildReport({
        agent,
        workspaceTitle: workspace?.title ?? null,
        diff,
        answer,
        entries: page.entries,
        now: this.now(),
      });
      const folder = await this.projectFolder(
        workspace?.projectId ?? null,
        workspace ? await this.projectName(workspace.projectId) : null,
      );
      const id = await this.writeDoc(this.deps.state.value.reports[agentId] ?? null, title, blocks, folder);
      await this.track(id, agentId, "report", title);
      this.markAgent(agentId);
      this.notice(`Report updated: ${agentTitle(agent)}`);
      return fileUrl.doc(id);
    });
  }

  exportPlan(agentId: string): Promise<string> {
    return this.run("plan", async () => {
      const agent = await this.ctx.agents.get(agentId);
      if (!agent) throw new Error(`No agent ${agentId}`);
      const page = await this.ctx.agents.getTimeline(agentId, { limit: 500 });
      const plan = summarizeTimeline(page.entries).plan;
      if (!plan) throw new Error("This session has no plan yet. Ask the agent to plan first.");
      const workspace = await this.workspaceOf(agent);
      const folder = await this.projectFolder(
        workspace?.projectId ?? null,
        workspace ? await this.projectName(workspace.projectId) : null,
      );
      const { title, blocks } = buildPlanDoc(agent, plan);
      const id = await this.writeDoc(null, title, blocks, folder);
      await this.track(id, agentId, "plan", title);
      this.notice(`Plan exported: ${agentTitle(agent)}`);
      return fileUrl.doc(id);
    });
  }

  // ------------------------------------------------------------- attention

  async onAgentFinished(agentId: string, reason: string, message: string | null): Promise<void> {
    this.markAgent(agentId);
    const pending = this.deps.state.value.pendingReplies.filter((p) => p.agentId === agentId);
    if (pending.length && reason !== "permission") {
      await this.run("comment replies", async () => {
        const answer = message?.trim() || (await this.ctx.agents.getLastAssistantMessage(agentId)) || "(no answer)";
        const prefix = reason === "error" ? "The agent stopped with an error:\n\n" : "";
        for (const p of pending) {
          await this.deps.google.replyToComment(p.docId, p.commentId, prefix + truncate(answer, MAX_REPLY));
        }
        await this.deps.state.save((s) => {
          s.pendingReplies = s.pendingReplies.filter((p) => p.agentId !== agentId);
        });
      });
    }
    if (reason === "finished" && this.deps.config().reports === "all") {
      await this.exportReport(agentId).catch(() => undefined);
    }
  }

  // --------------------------------------------------------------- comments

  /** Reads new comments on tracked Docs and sends @frogg ones to their agent. */
  pollComments(): Promise<void> {
    if (!this.deps.config().comments) return Promise.resolve();
    return this.run("comments", async () => {
      const { google, state } = this.deps;
      for (const doc of Object.values(state.value.docs)) {
        const checkedAt = this.now().toISOString();
        let comments;
        try {
          comments = await google.listComments(doc.docId, doc.commentsCheckedAt);
        } catch (err) {
          if (err instanceof GoogleApiError && err.status === 404) {
            await state.save((s) => {
              delete s.docs[doc.docId];
            });
            continue;
          }
          throw err;
        }
        const handled = new Set(doc.handledComments);
        for (const c of comments) {
          if (handled.has(c.id) || c.resolved || c.deleted) continue;
          const text = commandFromComment(c.content);
          if (!text) continue;
          handled.add(c.id);
          await this.handleComment(doc.docId, doc.title, doc.agentId, c.id, c.author, text);
        }
        await state.save((s) => {
          const d = s.docs[doc.docId];
          if (d) {
            d.commentsCheckedAt = checkedAt;
            d.handledComments = [...handled].slice(-500);
          }
        });
      }
    });
  }

  private async handleComment(
    docId: string,
    docTitle: string,
    agentId: string,
    commentId: string,
    author: { displayName?: string; emailAddress?: string; me?: boolean },
    text: string,
  ): Promise<void> {
    const { google } = this.deps;
    const who = author.emailAddress ?? author.displayName ?? "someone";
    if (!isAllowedGoogleUser(this.deps.config(), author, this.deps.connectedEmail())) {
      await google.replyToComment(docId, commentId, `Frogg ignored this: ${who} is not on the plugin's list of allowed Google accounts.`);
      this.notice(`Ignored a comment from ${who} (not allowed)`);
      return;
    }
    if (!this.ctx.host.remoteControl) {
      await google.replyToComment(docId, commentId, "Not sent: remote control is off for the Google Workspace plugin in Frogg. The host owner can turn it on under Plugins.");
      return;
    }
    try {
      await this.ctx.agents.sendMessage(agentId, `Comment on the Google Doc "${docTitle}" from ${who}:\n\n${text}`, {
        actor: `google:${author.emailAddress ?? (author.me ? (this.deps.connectedEmail() ?? "owner") : who)}`,
      });
    } catch (err) {
      await google.replyToComment(docId, commentId, `Frogg couldn't send this to the agent: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await google.replyToComment(docId, commentId, "Sent to the agent. Its answer will appear here.");
    await this.deps.state.save((s) => {
      s.pendingReplies.push({ docId, commentId, agentId, sentAt: this.now().toISOString() });
    });
    this.notice(`Comment from ${who} sent to the agent`);
  }

  // ------------------------------------------------------------------ to-dos

  markProject(projectId: string): void {
    if (!this.deps.config().todos) return;
    this.todoDirty.add(projectId);
    this.todoTimer ??= setTimeout(() => {
      this.todoTimer = null;
      const ids = [...this.todoDirty];
      this.todoDirty.clear();
      for (const id of ids) void this.syncTodos(id).catch(() => undefined);
    }, 5000);
  }

  private async ensureTodoSheet(projectId: string) {
    const { state, google } = this.deps;
    const known = state.value.todos[projectId];
    if (known && (await google.fileExists(known.spreadsheetId))) return known;
    const name = (await this.projectName(projectId)) ?? projectId;
    const id = await google.createFile(`Frogg to-dos — ${name}`, MIME.sheet, await this.projectFolder(projectId, name));
    await google.sheetsBatchUpdate(id, [
      { updateSheetProperties: { properties: { sheetId: 0, title: TODO_SHEET, gridProperties: { frozenRowCount: 1 } }, fields: "title,gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
      {
        setDataValidation: {
          range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
          rule: { condition: { type: "ONE_OF_LIST", values: ["backlog", "ready", "claimed", "in_progress", "review", "done", "blocked"].map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true },
        },
      },
      {
        setDataValidation: {
          range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
          rule: { condition: { type: "ONE_OF_LIST", values: ["low", "medium", "high", "urgent"].map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true },
        },
      },
    ]);
    const entry = { spreadsheetId: id, snapshot: {} };
    await state.save((s) => {
      s.todos[projectId] = entry;
    });
    this.notice(`Created the to-do sheet for ${name}`);
    return entry;
  }

  /** Reads Sheet edits into Frogg, then rewrites the Sheet from Frogg. */
  syncTodos(projectId: string): Promise<void> {
    return this.run("to-dos", async () => {
      if (!this.ctx.todos) return;
      const { google, state } = this.deps;
      const sheet = await this.ensureTodoSheet(projectId);
      let todos = await this.ctx.todos.list(projectId);
      const rows = await google.getValues(sheet.spreadsheetId, `${TODO_SHEET}!A1:${TODO_LAST_COL}`);
      const ops = diffTodoSheet(rows, sheet.snapshot, todos);
      if (ops.some((o) => o.kind !== "rejected")) {
        if (this.ctx.host.remoteControl) {
          await this.applyTodoOps(projectId, ops);
          todos = await this.ctx.todos.list(projectId);
        } else {
          this.notice("Sheet edits to to-dos were not applied: remote control is off");
        }
      }
      for (const op of ops) if (op.kind === "rejected") this.notice(`To-do sheet: ${op.reason}`);
      const values = [TODO_HEADER, ...sortTodos(todos).map(todoRow)];
      await google.batchUpdateValues(sheet.spreadsheetId, [
        { range: `${TODO_SHEET}!A1:${TODO_LAST_COL}${values.length}`, values },
      ]);
      if (rows.length > values.length)
        await google.clearValues(sheet.spreadsheetId, `${TODO_SHEET}!A${values.length + 1}:${TODO_LAST_COL}${rows.length}`);
      await state.save((s) => {
        const entry = s.todos[projectId];
        if (entry) entry.snapshot = Object.fromEntries(todos.map((t) => [t.id, todoFields(t)]));
      });
    });
  }

  private async applyTodoOps(projectId: string, ops: ReturnType<typeof diffTodoSheet>): Promise<void> {
    const todosApi = this.ctx.todos;
    const actor = `google:${this.deps.connectedEmail() ?? "sheet"}`;
    for (const op of ops) {
      try {
        if (op.kind === "create") {
          await todosApi.create(
            projectId,
            {
              title: op.fields.title,
              description: op.fields.description,
              category: op.fields.category || null,
              ...(validPriority(op.fields.priority) ? { priority: op.fields.priority } : {}),
            },
            { actor },
          );
        } else if (op.kind === "update") {
          await todosApi.update(projectId, op.todoId, { ...op.patch, ...(op.patch.category !== undefined ? { category: op.patch.category || null } : {}) }, { actor });
        } else if (op.kind === "status") {
          await todosApi.setStatus(projectId, op.todoId, op.status, { actor });
        }
      } catch (err) {
        this.notice(`To-do sheet: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async syncAllTodos(): Promise<void> {
    if (!this.deps.config().todos || !this.ctx.workspaces) return;
    const projects = await this.ctx.workspaces.listProjects();
    for (const p of projects) await this.syncTodos(p.id).catch(() => undefined);
  }

  /** Inbound only for projects that already have a Sheet; cheap enough for the poll loop. */
  async pollTodos(): Promise<void> {
    if (!this.deps.config().todos) return;
    for (const projectId of Object.keys(this.deps.state.value.todos))
      await this.syncTodos(projectId).catch(() => undefined);
  }

  // ------------------------------------------------------------------ decks

  createDeck(days = 7): Promise<string> {
    return this.run("deck", async () => {
      const since = this.now().getTime() - days * 86_400_000;
      const agents = (await this.ctx.agents.list())
        .filter((a) => a.status !== "running" && Date.parse(a.updatedAt ?? "") >= since)
        .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
        .slice(0, 20);
      if (!agents.length) throw new Error(`No agents finished in the last ${days} days`);
      const slides = [];
      for (const a of agents) {
        const [answer, diff] = await Promise.all([
          this.ctx.agents.getLastAssistantMessage(a.id).catch(() => null),
          this.ctx.agents.getDiffStat(a.id).catch(() => null),
        ]);
        const facts = [diff ? `+${diff.additions} −${diff.deletions} lines` : null, a.prUrl].filter(Boolean).join(" · ");
        slides.push({ title: agentTitle(a), body: [answerGist(answer), facts].filter(Boolean).join("\n") });
      }
      const { google } = this.deps;
      const date = this.now().toISOString().slice(0, 10);
      const title = `Frogg release notes — ${date}`;
      const id = await google.createFile(title, MIME.slides, await this.rootFolder());
      const initial = (await google.getPresentation(id)).slides ?? [];
      await google.slidesBatchUpdate(id, [
        ...deckRequests(title, `${agents.length} agent runs from the last ${days} days`, slides),
        ...initial.map((s) => ({ deleteObject: { objectId: s.objectId } })),
      ]);
      await this.deps.state.save((s) => {
        s.decks.unshift({ id, title, createdAt: this.now().toISOString() });
        s.decks.length = Math.min(s.decks.length, 10);
      });
      this.notice(`Deck created: ${title}`);
      return fileUrl.slides(id);
    });
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const STATUS_ORDER = ["in_progress", "claimed", "review", "ready", "blocked", "backlog", "done"];

function sortTodos(todos: PluginTodo[]): PluginTodo[] {
  return [...todos].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.createdAt.localeCompare(b.createdAt),
  );
}
