// Plugin settings with their defaults applied. The host stores only what the user set.
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  allowedEmails: string[];
  ledger: boolean;
  reports: "all" | "manual";
  todos: boolean;
  comments: boolean;
  pollSeconds: number;
  folderName: string;
}

export function splitList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseConfig(raw: Record<string, unknown>): GoogleConfig {
  const poll = Number(raw.pollSeconds ?? 60);
  return {
    clientId: typeof raw.clientId === "string" ? raw.clientId.trim() : "",
    clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret.trim() : "",
    allowedEmails: splitList(raw.allowedEmails),
    ledger: bool(raw.ledger, true),
    reports: raw.reports === "manual" ? "manual" : "all",
    todos: bool(raw.todos, true),
    comments: bool(raw.comments, true),
    pollSeconds: Number.isFinite(poll) && poll >= 15 ? poll : 60,
    folderName:
      typeof raw.folderName === "string" && raw.folderName.trim() ? raw.folderName.trim() : "Frogg",
  };
}

export function missingConfig(config: GoogleConfig): string[] {
  const missing: string[] = [];
  if (!config.clientId) missing.push("OAuth client ID");
  if (!config.clientSecret) missing.push("OAuth client secret");
  return missing;
}

/** Whether a Google identity may drive agents and to-dos. The connected account always may. */
export function isAllowedGoogleUser(
  config: GoogleConfig,
  user: { me?: boolean; emailAddress?: string; displayName?: string },
  connectedEmail: string | null,
): boolean {
  if (user.me) return true;
  const email = user.emailAddress?.toLowerCase();
  if (!email) return false;
  if (connectedEmail && email === connectedEmail.toLowerCase()) return true;
  return config.allowedEmails.includes(email);
}
