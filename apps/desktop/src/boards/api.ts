// The Boards routes as the Device calls them (apps/server/src/routes/boards.ts).
// Built from the API client's own request helper, so the target, the token
// and the error handling are the same as every other route.

import type { Board, BoardDoc, BoardDraft, Id } from "@monday/shared";

export type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

const body = (method: string, value: unknown): RequestInit => ({
  method,
  body: JSON.stringify(value),
});
const at = (id: Id) => `/boards/${encodeURIComponent(id)}`;

export function boardsApi(request: Requester) {
  return {
    /** The Workspace's Boards not deleted, in nav order, decrypted (423 when locked). */
    list: (workspaceId: Id) =>
      request<{ boards: Board[] }>(
        `/boards?${new URLSearchParams({ workspace: workspaceId })}`,
      ).then((r) => r.boards),
    get: (id: Id) => request<Board>(at(id)),
    version: (id: Id, version: number) =>
      request<{ doc: BoardDoc }>(`${at(id)}/versions/${version}`).then((r) => r.doc),
    create: (workspaceId: Id, doc: BoardDoc, checkBar = false) =>
      request<Board>("/boards", body("POST", { workspace: workspaceId, doc, checkBar })),
    update: (id: Id, doc: BoardDoc) =>
      request<{ board: Board; previous: number }>(at(id), body("PUT", { doc })),
    revert: (id: Id, version: number) =>
      request<Board>(`${at(id)}/revert`, body("POST", { version })),
    move: (id: Id, by: -1 | 1) =>
      request<{ boards: Board[] }>(`${at(id)}/move`, body("POST", { by })).then((r) => r.boards),
    pin: (id: Id, pinned: boolean) => request<Board>(`${at(id)}/pin`, body("POST", { pinned })),
    remove: (id: Id) => request<Board>(at(id), { method: "DELETE" }),
    restore: (id: Id) => request<Board>(`${at(id)}/restore`, { method: "POST" }),
    /** "Move to" on the Board: the Thread stays in that Lane until it changes; null takes it back. */
    place: (id: Id, threadId: Id, lane: string | null) =>
      request<Board>(`${at(id)}/place`, body("POST", { threadId, lane })),
    dismissCheck: (id: Id) => request<Board>(`${at(id)}/dismiss-check`, { method: "POST" }),
    /** The Agent's draft (slice 40): read, correct, revise, pin or discard. */
    draft: (draftId: Id) => request<BoardDraft>(`/boards/drafts/${encodeURIComponent(draftId)}`),
    correct: (
      draftId: Id,
      correction: { threadId: Id; lane?: string; signal?: string; holds?: boolean },
    ) =>
      request<BoardDraft>(
        `/boards/drafts/${encodeURIComponent(draftId)}/corrections`,
        body("POST", correction),
      ),
    pinDraft: (draftId: Id, options: { factsOnly?: boolean } = {}) =>
      request<{ board: Board; draft: BoardDraft }>(
        `/boards/drafts/${encodeURIComponent(draftId)}/pin`,
        body("POST", options),
      ),
    applyDraft: (draftId: Id) =>
      request<{ board: Board; draft: BoardDraft; previous: number }>(
        `/boards/drafts/${encodeURIComponent(draftId)}/apply`,
        { method: "POST" },
      ),
    discardDraft: (draftId: Id) =>
      request<BoardDraft>(`/boards/drafts/${encodeURIComponent(draftId)}/discard`, {
        method: "POST",
      }),
  };
}

export type BoardsApi = ReturnType<typeof boardsApi>;
