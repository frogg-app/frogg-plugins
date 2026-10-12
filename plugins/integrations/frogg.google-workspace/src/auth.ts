// Google OAuth for a headless daemon: the device-code flow ("TVs and Limited Input devices"
// client). The user opens a URL on any device and types a short code; the daemon polls for the
// tokens. Scope is drive.file only: the plugin can touch the files it creates and nothing else,
// which keeps the consent screen out of Google's restricted-scope review.
import { promises as fs } from "node:fs";
import path from "node:path";

export const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const SCOPES = "https://www.googleapis.com/auth/drive.file openid email";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface StoredTokens {
  refreshToken: string;
  email: string | null;
  accessToken?: string;
  /** epoch ms */
  expiresAt?: number;
}

export interface DeviceCodeState {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export class GoogleAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/** The email claim of an id_token, without verifying it (it came straight from Google over TLS). */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export class TokenStore {
  readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "google-tokens.json");
  }
  async read(): Promise<StoredTokens | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as StoredTokens;
      return typeof raw.refreshToken === "string" && raw.refreshToken ? raw : null;
    } catch {
      return null;
    }
  }
  async write(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(tokens), { mode: 0o600 });
  }
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

export interface GoogleAuthOptions {
  clientId: () => string;
  clientSecret: () => string;
  store: TokenStore;
  fetch: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new GoogleAuthError("aborted", "Sign-in cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new GoogleAuthError("aborted", "Sign-in cancelled"));
      },
      { once: true },
    );
  });
}

export class GoogleAuth {
  private tokens: StoredTokens | null = null;
  private loaded = false;
  private refreshing: Promise<string> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  private readonly opts: GoogleAuthOptions;

  constructor(opts: GoogleAuthOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async load(): Promise<StoredTokens | null> {
    if (!this.loaded) {
      this.tokens = await this.opts.store.read();
      this.loaded = true;
    }
    return this.tokens;
  }

  get email(): string | null {
    return this.tokens?.email ?? null;
  }

  get connected(): boolean {
    return this.tokens !== null;
  }

  /** Step 1: ask Google for a device code to show the user. */
  async startDeviceFlow(): Promise<DeviceCodeState & { deviceCode: string; intervalMs: number }> {
    const clientId = this.opts.clientId();
    if (!clientId) throw new GoogleAuthError("not_configured", "Set the OAuth client ID first");
    const { ok, json } = await postForm(this.opts.fetch, DEVICE_CODE_URL, {
      client_id: clientId,
      scope: SCOPES,
    });
    if (!ok || typeof json.device_code !== "string" || typeof json.user_code !== "string") {
      throw new GoogleAuthError(
        String(json.error ?? "device_code_failed"),
        String(json.error_description ?? json.error ?? "Google refused the device-code request"),
      );
    }
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUrl: String(json.verification_url ?? json.verification_uri ?? "https://www.google.com/device"),
      expiresAt: this.now() + Number(json.expires_in ?? 1800) * 1000,
      intervalMs: Math.max(5, Number(json.interval ?? 5)) * 1000,
    };
  }

  /** Step 2: poll until the user approves, declines or the code expires. */
  async completeDeviceFlow(
    flow: { deviceCode: string; expiresAt: number; intervalMs: number },
    signal: AbortSignal,
  ): Promise<StoredTokens> {
    let interval = flow.intervalMs;
    while (this.now() < flow.expiresAt) {
      await this.sleep(interval, signal);
      const { ok, json } = await postForm(this.opts.fetch, TOKEN_URL, {
        client_id: this.opts.clientId(),
        client_secret: this.opts.clientSecret(),
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (ok && typeof json.refresh_token === "string") {
        const tokens: StoredTokens = {
          refreshToken: json.refresh_token,
          email: emailFromIdToken(json.id_token),
          accessToken: typeof json.access_token === "string" ? json.access_token : undefined,
          expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000,
        };
        await this.opts.store.write(tokens);
        this.tokens = tokens;
        this.loaded = true;
        return tokens;
      }
      const error = String(json.error ?? "");
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval += 5000;
        continue;
      }
      throw new GoogleAuthError(
        error || "token_failed",
        error === "access_denied"
          ? "Sign-in was declined"
          : String(json.error_description ?? (error || "Google refused the sign-in")),
      );
    }
    throw new GoogleAuthError("expired_token", "The sign-in code expired; start again");
  }

  /** A valid access token, refreshed when it is within a minute of expiry. */
  async accessToken(force = false): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new GoogleAuthError("not_connected", "Connect a Google account first");
    if (!force && tokens.accessToken && (tokens.expiresAt ?? 0) - 60_000 > this.now())
      return tokens.accessToken;
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(tokens: StoredTokens): Promise<string> {
    const { ok, json } = await postForm(this.opts.fetch, TOKEN_URL, {
      client_id: this.opts.clientId(),
      client_secret: this.opts.clientSecret(),
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    });
    if (!ok || typeof json.access_token !== "string") {
      if (json.error === "invalid_grant") {
        await this.disconnect(false);
        throw new GoogleAuthError("not_connected", "Google access was revoked; connect again");
      }
      throw new GoogleAuthError(String(json.error ?? "refresh_failed"), "Could not refresh Google access");
    }
    const next: StoredTokens = {
      ...tokens,
      accessToken: json.access_token,
      expiresAt: this.now() + Number(json.expires_in ?? 3600) * 1000,
    };
    this.tokens = next;
    await this.opts.store.write(next);
    return next.accessToken!;
  }

  async disconnect(revoke = true): Promise<void> {
    const tokens = await this.load();
    if (revoke && tokens) {
      await postForm(this.opts.fetch, REVOKE_URL, { token: tokens.refreshToken }).catch(
        () => undefined,
      );
    }
    this.tokens = null;
    await this.opts.store.clear();
  }
}
