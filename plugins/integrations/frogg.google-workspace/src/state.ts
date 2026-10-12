// Durable plugin state in dataDir/state.json: the Google files the plugin created and what it last
// synced. Writes are coalesced and atomic (temp file + rename).
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TodoFields } from "./format.ts";

export interface TrackedDoc {
  docId: string;
  agentId: string;
  kind: "report" | "plan";
  title: string;
  /** Comments modified after this were not read yet. */
  commentsCheckedAt: string | null;
  /** Comment ids already sent to the agent (or refused). */
  handledComments: string[];
}

export interface PendingReply {
  docId: string;
  commentId: string;
  agentId: string;
  sentAt: string;
}

export interface GoogleState {
  rootFolderId: string | null;
  projectFolders: Record<string, string>;
  ledger: { spreadsheetId: string; rows: Record<string, number> } | null;
  docs: Record<string, TrackedDoc>;
  /** Report doc id per agent. */
  reports: Record<string, string>;
  pendingReplies: PendingReply[];
  todos: Record<string, { spreadsheetId: string; snapshot: Record<string, TodoFields> }>;
  decks: { id: string; title: string; createdAt: string }[];
}

export function emptyState(): GoogleState {
  return {
    rootFolderId: null,
    projectFolders: {},
    ledger: null,
    docs: {},
    reports: {},
    pendingReplies: [],
    todos: {},
    decks: [],
  };
}

export class StateFile {
  private readonly file: string;
  private state: GoogleState = emptyState();
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "state.json");
  }

  async load(): Promise<GoogleState> {
    try {
      this.state = { ...emptyState(), ...(JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<GoogleState>) };
    } catch {
      this.state = emptyState();
    }
    return this.state;
  }

  get value(): GoogleState {
    return this.state;
  }

  /** Mutates in place and schedules one write; concurrent saves coalesce. */
  save(mutate?: (s: GoogleState) => void): Promise<void> {
    mutate?.(this.state);
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }

  /** Forgets everything tied to the Google account, keeping nothing that points into it. */
  reset(): Promise<void> {
    this.state = emptyState();
    return this.save();
  }
}
