// Agent <-> thread and pending-permission bookkeeping, persisted to the plugin's dataDir so a
// daemon restart keeps editing the same Discord messages instead of opening new threads.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginPermissionRequest } from "@frogg/plugin-api";

export interface AgentThread {
  threadId: string;
  /** Channel holding the status message: the thread itself (forum) or its parent (text). */
  statusChannelId: string;
  statusMessageId: string;
  /** The guild/channel this was created for; a settings change to another channel starts over. */
  homeChannelId: string;
  /** Timeline resume point (host cursor) after the last entry this plugin handled. */
  cursor?: string;
}

export interface PendingPermission {
  agentId: string;
  requestId: string;
  channelId: string;
  messageId: string;
  /** Kept so the message can be re-rendered when remote control flips. */
  request?: PluginPermissionRequest;
}

interface StateFile {
  version: 1;
  agents: Record<string, AgentThread>;
  permissions: Record<string, PendingPermission>;
}

export class StateStore {
  private data: StateFile = { version: 1, agents: {}, permissions: {} };
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  static forDataDir(dataDir: string): StateStore {
    return new StateStore(path.join(dataDir, "state.json"));
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StateFile>;
      if (parsed.version === 1) {
        this.data = { version: 1, agents: parsed.agents ?? {}, permissions: parsed.permissions ?? {} };
      }
    } catch {
      // Missing or corrupt: start empty; threads get recreated on demand.
    }
  }

  thread(agentId: string): AgentThread | undefined {
    return this.data.agents[agentId];
  }

  agentForThread(threadId: string): string | undefined {
    for (const [agentId, t] of Object.entries(this.data.agents)) {
      if (t.threadId === threadId) return agentId;
    }
    return undefined;
  }

  setThread(agentId: string, thread: AgentThread): void {
    this.data.agents[agentId] = thread;
    this.save();
  }

  deleteThread(agentId: string): void {
    delete this.data.agents[agentId];
    for (const [key, p] of Object.entries(this.data.permissions)) {
      if (p.agentId === agentId) delete this.data.permissions[key];
    }
    this.save();
  }

  /** Cursors change on every timeline entry, so their writes are batched. */
  setCursor(agentId: string, cursor: string): void {
    const t = this.data.agents[agentId];
    if (!t || t.cursor === cursor) return;
    t.cursor = cursor;
    this.saveSoon();
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  permission(key: string): PendingPermission | undefined {
    return this.data.permissions[key];
  }

  findPermission(agentId: string, requestId: string): [string, PendingPermission] | undefined {
    return Object.entries(this.data.permissions).find(
      ([, p]) => p.agentId === agentId && p.requestId === requestId,
    );
  }

  setPermission(key: string, p: PendingPermission): void {
    this.data.permissions[key] = p;
    this.save();
  }

  deletePermission(key: string): void {
    delete this.data.permissions[key];
    this.save();
  }

  allPermissions(): [string, PendingPermission][] {
    return Object.entries(this.data.permissions);
  }

  /** Serialised, atomic (tmp + rename) writes; bursts collapse into one. */
  save(): void {
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const tmp = `${this.file}.tmp`;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.file);
    }).catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
    await this.writing;
  }
}
