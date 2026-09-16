// Well-known folders: SPECIAL-USE (RFC 6154) and Gmail's XLIST flags first,
// then name matching for servers that advertise neither.

import type { MailboxRole } from "../types.ts";

const FLAG_ROLES: Record<string, MailboxRole> = {
  "\\Inbox": "inbox",
  "\\Archive": "archive",
  "\\Drafts": "drafts",
  "\\Sent": "sent",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\All": "all",
  "\\Important": "important",
  "\\Flagged": "flagged",
};

/** Lowercased last path segment to role, covering common localizations and provider names. */
const NAME_ROLES: Record<string, MailboxRole> = {
  inbox: "inbox",
  archive: "archive",
  archives: "archive",
  archived: "archive",
  "all mail": "all",
  drafts: "drafts",
  draft: "drafts",
  sent: "sent",
  "sent items": "sent",
  "sent mail": "sent",
  "sent messages": "sent",
  trash: "trash",
  "deleted items": "trash",
  "deleted messages": "trash",
  bin: "trash",
  junk: "junk",
  spam: "junk",
  "junk e-mail": "junk",
  "junk email": "junk",
  "bulk mail": "junk",
  important: "important",
  starred: "flagged",
  flagged: "flagged",
};

export interface FolderLike {
  path: string;
  name: string;
  flags: ReadonlySet<string>;
  specialUse?: string | undefined;
}

export function roleOfFolder(folder: FolderLike): MailboxRole | null {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  if (folder.specialUse && FLAG_ROLES[folder.specialUse])
    return FLAG_ROLES[folder.specialUse] ?? null;
  for (const flag of folder.flags) {
    const role = FLAG_ROLES[flag];
    if (role) return role;
  }
  const name = folder.name.trim().toLowerCase();
  return NAME_ROLES[name] ?? null;
}

/** First folder with the role, preferring ones the server marked over name matches. */
export function folderWithRole<T extends FolderLike>(folders: T[], role: MailboxRole): T | null {
  const marked = folders.find(
    (f) =>
      roleOfFolder(f) === role &&
      (f.specialUse !== undefined || [...f.flags].some((flag) => flag in FLAG_ROLES)),
  );
  return marked ?? folders.find((f) => roleOfFolder(f) === role) ?? null;
}

/** Hosts whose SMTP submission stores a copy in Sent itself (research, "Sent copies"). */
export function serverSavesSentCopy(smtpHost: string): boolean {
  const host = smtpHost.toLowerCase();
  return /(^|\.)(gmail\.com|googlemail\.com|google\.com|office365\.com|outlook\.com|hotmail\.com|live\.com|office\.com)$/.test(
    host,
  );
}
