// The seam between the compose surfaces and the data under them (ADR 0010).
// Drafts and sends are read as stable snapshots with a subscription; every
// write is an intent the Store applies locally first, so autosave, Send and
// Undo all work offline. fixtureComposer() is the in-memory implementation
// for tests and the fixture inbox; store-composer.ts is the Store's.

import type {
  Draft,
  DraftAssistRequest,
  DraftAssistResult,
  DraftAttachment,
  DraftContent,
  Person,
  ScheduledSend,
} from "@monday/shared";

/** An assist request without the Workspace, which the Composer knows. */
export type AssistRequest = Omit<DraftAssistRequest, "workspace">;

export interface SendOptions {
  delaySeconds?: number | undefined;
  /** Send later: an absolute time. */
  runAt?: string | undefined;
}

export interface UploadFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** What the Agent proposes for a Draft: a continuation shown faint, a note with a yes or no. */
export interface DraftSuggestion {
  ghost?: string | undefined;
  note?: string | undefined;
}

export interface Composer {
  readonly workspaceId: string;
  /** The Account's address: who a Draft is from, and who a reply leaves out. */
  readonly address: string;
  /** Open Drafts, newest first. Stable between changes. */
  drafts(): readonly Draft[];
  draft(id: string): Draft | undefined;
  /** Every send the Cache knows, pending first then newest. */
  sends(): readonly ScheduledSend[];
  subscribe(listener: () => void): () => void;
  /** Saves the content under the id; a new id creates the Draft. */
  save(id: string, content: DraftContent): Promise<void>;
  discard(id: string): Promise<void>;
  /** Schedules the send Job; the countdown starts from runAt. */
  send(id: string, options?: SendOptions): Promise<{ sendId: string; runAt: string }>;
  /** Undo: cancels before run_at and reopens the Draft. */
  cancel(sendId: string): Promise<void>;
  upload(file: UploadFile, onProgress?: (fraction: number) => void): Promise<DraftAttachment>;
  /** Everyone the Cache has seen, most recent first, for the recipient autocomplete. */
  participants(): readonly Person[];
  /** The remembered reply-all choice for a Thread, or null. */
  replyAllFor(threadId: string): boolean | null;
  setReplyAllFor(threadId: string, replyAll: boolean): Promise<void>;
  /** A Draft whose content is newer on the Server is fetched before editing. */
  ensureContent(id: string): Promise<Draft | undefined>;
  /** The Agent's suggestion for a Draft, when it has one. */
  suggestion(id: string): DraftSuggestion | null;
  /**
   * The writing assist: rewrites, grammar, translation, continuation or a
   * free instruction over some text, answered by the Server's model. Absent
   * when no Server can answer; rejects with the Server's reason otherwise.
   */
  assist?(request: AssistRequest): Promise<DraftAssistResult>;
  /** Whether the assist can answer now (a runtime is configured); asked once per window. */
  assistAvailable?(): Promise<boolean>;
}

export interface FixtureComposerOptions {
  workspaceId?: string;
  address?: string;
  participants?: readonly Person[];
  drafts?: readonly Draft[];
  suggestions?: Readonly<Record<string, DraftSuggestion>>;
  delaySeconds?: number;
  now?: () => Date;
  /** The writing assist; absent means the composer offers none. */
  assist?: ((request: AssistRequest) => Promise<DraftAssistResult>) | undefined;
}

export function fixtureComposer(options: FixtureComposerOptions = {}): Composer & {
  /** Runs every send whose run_at has passed. */
  runDue(now?: Date): number;
} {
  const workspaceId = options.workspaceId ?? "ws-genai";
  const address = options.address ?? "tejas@genai-labs.io";
  const now = options.now ?? (() => new Date());
  const delaySeconds = options.delaySeconds ?? 30;
  const drafts = new Map<string, Draft>();
  for (const d of options.drafts ?? []) drafts.set(d.id, structuredClone(d));
  const sends = new Map<string, ScheduledSend>();
  const prefs = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  let draftList: readonly Draft[] | null = null;
  let sendList: readonly ScheduledSend[] | null = null;
  let blobSeq = 0;

  const emit = () => {
    draftList = null;
    sendList = null;
    for (const l of [...listeners]) l();
  };

  return {
    workspaceId,
    address,
    drafts() {
      draftList ??= [...drafts.values()]
        .filter((d) => d.status !== "sent")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return draftList;
    },
    draft: (id) => drafts.get(id),
    sends() {
      sendList ??= [...sends.values()].sort((a, b) => {
        if (a.status === "scheduled" && b.status !== "scheduled") return -1;
        if (b.status === "scheduled" && a.status !== "scheduled") return 1;
        return b.runAt.localeCompare(a.runAt);
      });
      return sendList;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async save(id, content) {
      const existing = drafts.get(id);
      drafts.set(id, {
        id,
        workspaceId,
        ...content,
        attachmentBlobIds: content.attachments.map((a) => a.blobId),
        status: existing?.status ?? "open",
        updatedAt: now().toISOString(),
        updatedBy: "device",
      });
      emit();
    },
    async discard(id) {
      drafts.delete(id);
      emit();
    },
    async send(id, sendOptions = {}) {
      const draft = drafts.get(id);
      if (!draft) throw new Error(`no draft ${id}`);
      const runAt =
        sendOptions.runAt ??
        new Date(now().getTime() + (sendOptions.delaySeconds ?? delaySeconds) * 1000).toISOString();
      const sendId = `send-${sends.size + 1}`;
      sends.set(sendId, {
        id: sendId,
        workspaceId,
        draftId: id,
        runAt,
        status: "scheduled",
        cancelledAt: null,
        sentAt: null,
        jobId: sendId,
        error: null,
        createdAt: now().toISOString(),
      });
      drafts.set(id, { ...draft, status: "scheduled" });
      emit();
      return { sendId, runAt };
    },
    async cancel(sendId) {
      const send = sends.get(sendId);
      if (send?.status !== "scheduled") return;
      sends.set(sendId, { ...send, status: "cancelled", cancelledAt: now().toISOString() });
      const draft = drafts.get(send.draftId);
      if (draft) drafts.set(draft.id, { ...draft, status: "open" });
      emit();
    },
    async upload(file, onProgress) {
      onProgress?.(1);
      blobSeq += 1;
      return {
        blobId: `blob-${blobSeq}`,
        name: file.name,
        size: file.bytes.length,
        mediaType: file.mediaType,
      };
    },
    participants: () => options.participants ?? [],
    replyAllFor: (threadId) => prefs.get(threadId) ?? null,
    async setReplyAllFor(threadId, replyAll) {
      prefs.set(threadId, replyAll);
    },
    async ensureContent(id) {
      return drafts.get(id);
    },
    suggestion: (id) => options.suggestions?.[id] ?? null,
    ...(options.assist ? { assist: options.assist, assistAvailable: async () => true } : {}),
    runDue(at = now()) {
      let ran = 0;
      for (const send of [...sends.values()]) {
        if (send.status !== "scheduled" || Date.parse(send.runAt) > at.getTime()) continue;
        sends.set(send.id, { ...send, status: "sent", sentAt: at.toISOString() });
        const draft = drafts.get(send.draftId);
        if (draft) drafts.set(draft.id, { ...draft, status: "sent" });
        ran += 1;
      }
      if (ran) emit();
      return ran;
    },
  };
}
