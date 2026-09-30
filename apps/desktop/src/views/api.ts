// The Views routes as the Device calls them (apps/server/src/routes/views.ts).
// Built from the API client's own request helper, so the target, the token
// and the error handling are the same as every other route.

import type { ExtractedValue, Id, View, ViewDoc, ViewDraft } from "@monday/shared";

export type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

const body = (method: string, value: unknown): RequestInit => ({
  method,
  body: JSON.stringify(value),
});
const at = (id: Id) => `/views/${encodeURIComponent(id)}`;

export function viewsApi(request: Requester) {
  return {
    /** The Workspace's Views not deleted, in nav order, decrypted (423 when locked). */
    list: (workspaceId: Id) =>
      request<{ views: View[] }>(`/views?${new URLSearchParams({ workspace: workspaceId })}`).then(
        (r) => r.views,
      ),
    get: (id: Id) => request<View>(at(id)),
    version: (id: Id, version: number) =>
      request<{ doc: ViewDoc }>(`${at(id)}/versions/${version}`).then((r) => r.doc),
    create: (workspaceId: Id, doc: ViewDoc, checkBar = false) =>
      request<View>("/views", body("POST", { workspace: workspaceId, doc, checkBar })),
    update: (id: Id, doc: ViewDoc) =>
      request<{ view: View; previous: number }>(at(id), body("PUT", { doc })),
    revert: (id: Id, version: number) =>
      request<View>(`${at(id)}/revert`, body("POST", { version })),
    move: (id: Id, by: -1 | 1) =>
      request<{ views: View[] }>(`${at(id)}/move`, body("POST", { by })).then((r) => r.views),
    pin: (id: Id, pinned: boolean) => request<View>(`${at(id)}/pin`, body("POST", { pinned })),
    remove: (id: Id) => request<View>(at(id), { method: "DELETE" }),
    restore: (id: Id) => request<View>(`${at(id)}/restore`, { method: "POST" }),
    /** "Move to" on the View: the Thread stays in that Lane until it changes; null takes it back. */
    place: (id: Id, threadId: Id, lane: string | null) =>
      request<View>(`${at(id)}/place`, body("POST", { threadId, lane })),
    dismissCheck: (id: Id) => request<View>(`${at(id)}/dismiss-check`, { method: "POST" }),
    /** A checklist item checked or unchecked, for the Thread version it was checked at. */
    done: (id: Id, threadId: Id, done: boolean, messageCount: number) =>
      request<View>(`${at(id)}/done`, body("POST", { threadId, done, messageCount })),
    /** Every value the View's Extractions picked, by Thread (decrypted; 423 when locked). */
    values: (id: Id) =>
      request<{ values: Record<Id, Record<string, ExtractedValue>> }>(`${at(id)}/values`).then(
        (r) => r.values,
      ),
    /** The values every View picked on these Threads (the feed named them). */
    valuesFor: (workspaceId: Id, threadIds: readonly Id[]) =>
      request<{ values: Record<Id, Record<string, ExtractedValue>> }>(
        "/views/values",
        body("POST", { workspace: workspaceId, threadIds }),
      ).then((r) => r.values),
    /** The Agent's draft (slice 40): read, correct, revise, pin or discard. */
    draft: (draftId: Id) => request<ViewDraft>(`/views/drafts/${encodeURIComponent(draftId)}`),
    correct: (
      draftId: Id,
      correction: {
        threadId: Id;
        lane?: string;
        signal?: string;
        holds?: boolean;
        /** "Wrong value": the Extraction and the span that is right, or null for not stated. */
        extraction?: string;
        value?: string | null;
      },
    ) =>
      request<ViewDraft>(
        `/views/drafts/${encodeURIComponent(draftId)}/corrections`,
        body("POST", correction),
      ),
    pinDraft: (draftId: Id, options: { factsOnly?: boolean } = {}) =>
      request<{ view: View; draft: ViewDraft }>(
        `/views/drafts/${encodeURIComponent(draftId)}/pin`,
        body("POST", options),
      ),
    applyDraft: (draftId: Id) =>
      request<{ view: View; draft: ViewDraft; previous: number }>(
        `/views/drafts/${encodeURIComponent(draftId)}/apply`,
        { method: "POST" },
      ),
    discardDraft: (draftId: Id) =>
      request<ViewDraft>(`/views/drafts/${encodeURIComponent(draftId)}/discard`, {
        method: "POST",
      }),
  };
}

export type ViewsApi = ReturnType<typeof viewsApi>;
