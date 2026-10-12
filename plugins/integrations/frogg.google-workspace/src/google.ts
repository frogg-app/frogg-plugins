// Minimal Google REST client over fetch: Drive, Sheets, Docs and Slides, only the calls the plugin
// makes. No SDK, so the bundle stays small. Retries 429/5xx with backoff and refreshes the access
// token once on 401.
import type { FetchLike } from "./auth.ts";

export const MIME = {
  folder: "application/vnd.google-apps.folder",
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
} as const;

export class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  me?: boolean;
}

export interface DriveComment {
  id: string;
  content: string;
  author: DriveUser;
  createdTime: string;
  modifiedTime: string;
  resolved?: boolean;
  deleted?: boolean;
  replies?: { id: string; content: string; author: DriveUser }[];
}

export interface GoogleClientOptions {
  token: (force?: boolean) => Promise<string>;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class GoogleClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly opts: GoogleClientOptions;
  constructor(opts: GoogleClientOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(
    method: string,
    url: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    let forced = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.token(forced);
      const res = await this.opts.fetch(u.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 401 && !forced) {
        forced = true;
        continue;
      }
      if (RETRY_STATUSES.has(res.status) && attempt < 4) {
        await this.sleep(Math.min(16_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 300);
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          // not JSON
        }
        throw new GoogleApiError(res.status, `Google ${res.status}: ${message}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  // ------------------------------------------------------------------ Drive

  async findFolder(name: string, parentId: string | null): Promise<string | null> {
    const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = [
      `mimeType='${MIME.folder}'`,
      `name='${escaped}'`,
      "trashed=false",
      ...(parentId ? [`'${parentId}' in parents`] : []),
    ].join(" and ");
    const res = await this.request<{ files?: { id: string }[] }>(
      "GET",
      "https://www.googleapis.com/drive/v3/files",
      undefined,
      { q, fields: "files(id)", pageSize: "1", spaces: "drive" },
    );
    return res.files?.[0]?.id ?? null;
  }

  async createFile(name: string, mimeType: string, parentId: string | null): Promise<string> {
    const res = await this.request<{ id: string }>(
      "POST",
      "https://www.googleapis.com/drive/v3/files",
      { name, mimeType, ...(parentId ? { parents: [parentId] } : {}) },
      { fields: "id" },
    );
    return res.id;
  }

  async ensureFolder(name: string, parentId: string | null): Promise<string> {
    return (await this.findFolder(name, parentId)) ?? this.createFile(name, MIME.folder, parentId);
  }

  async fileExists(fileId: string): Promise<boolean> {
    try {
      const res = await this.request<{ trashed?: boolean }>(
        "GET",
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        undefined,
        { fields: "trashed" },
      );
      return res.trashed !== true;
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return false;
      throw err;
    }
  }

  async listComments(fileId: string, startModifiedTime: string | null): Promise<DriveComment[]> {
    const out: DriveComment[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.request<{ comments?: DriveComment[]; nextPageToken?: string }>(
        "GET",
        `https://www.googleapis.com/drive/v3/files/${fileId}/comments`,
        undefined,
        {
          fields:
            "nextPageToken,comments(id,content,createdTime,modifiedTime,resolved,deleted,author(displayName,emailAddress,me),replies(id,content,author(displayName,emailAddress,me)))",
          pageSize: "100",
          includeDeleted: "false",
          startModifiedTime: startModifiedTime ?? undefined,
          pageToken,
        },
      );
      out.push(...(res.comments ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }

  async replyToComment(fileId: string, commentId: string, content: string): Promise<void> {
    await this.request(
      "POST",
      `https://www.googleapis.com/drive/v3/files/${fileId}/comments/${commentId}/replies`,
      { content: content.slice(0, 30_000) },
      { fields: "id" },
    );
  }

  // ----------------------------------------------------------------- Sheets

  async getValues(spreadsheetId: string, range: string): Promise<string[][]> {
    const res = await this.request<{ values?: unknown[][] }>(
      "GET",
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
      undefined,
      { valueRenderOption: "FORMATTED_VALUE" },
    );
    return (res.values ?? []).map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))));
  }

  async batchUpdateValues(
    spreadsheetId: string,
    data: { range: string; values: (string | number)[][] }[],
  ): Promise<void> {
    if (!data.length) return;
    await this.request(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      { valueInputOption: "RAW", data },
    );
  }

  async clearValues(spreadsheetId: string, range: string): Promise<void> {
    await this.request(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
      {},
    );
  }

  async sheetsBatchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
    if (!requests.length) return;
    await this.request(
      "POST",
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      { requests },
    );
  }

  // ------------------------------------------------------------------- Docs

  async docEndIndex(documentId: string): Promise<number> {
    const res = await this.request<{ body?: { content?: { endIndex?: number }[] } }>(
      "GET",
      `https://docs.googleapis.com/v1/documents/${documentId}`,
      undefined,
      { fields: "body(content(endIndex))" },
    );
    const content = res.body?.content ?? [];
    return content[content.length - 1]?.endIndex ?? 1;
  }

  async docsBatchUpdate(documentId: string, requests: unknown[]): Promise<void> {
    if (!requests.length) return;
    await this.request("POST", `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      requests,
    });
  }

  // ----------------------------------------------------------------- Slides

  async getPresentation(id: string): Promise<{ slides?: { objectId: string }[] }> {
    return this.request("GET", `https://slides.googleapis.com/v1/presentations/${id}`, undefined, {
      fields: "slides(objectId)",
    });
  }

  async slidesBatchUpdate(id: string, requests: unknown[]): Promise<void> {
    if (!requests.length) return;
    await this.request("POST", `https://slides.googleapis.com/v1/presentations/${id}:batchUpdate`, {
      requests,
    });
  }
}

export const fileUrl = {
  doc: (id: string) => `https://docs.google.com/document/d/${id}/edit`,
  sheet: (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`,
  slides: (id: string) => `https://docs.google.com/presentation/d/${id}/edit`,
  folder: (id: string) => `https://drive.google.com/drive/folders/${id}`,
};
