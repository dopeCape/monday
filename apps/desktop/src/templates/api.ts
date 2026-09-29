// The Templates routes as the Device calls them (apps/server/src/routes/templates.ts).
// Built from the API client's own request helper, so the target, the token
// and the error handling are the same as every other route.

import type {
  Id,
  Person,
  Template,
  TemplateFile,
  TemplateFillResult,
  TemplateInput,
  TemplateScope,
} from "@monday/shared";

export type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

const body = (method: string, value: unknown): RequestInit => ({
  method,
  body: JSON.stringify(value),
});

export function templatesApi(request: Requester) {
  return {
    /** The Workspace's own Templates, decrypted (423 when locked). */
    list: (workspaceId: Id) =>
      request<{ templates: Template[] }>(
        `/templates?${new URLSearchParams({ workspace: workspaceId })}`,
      ).then((r) => r.templates),
    get: (id: Id) => request<Template>(`/templates/${encodeURIComponent(id)}`),
    create: (workspaceId: Id, template: TemplateInput, scope?: TemplateScope) =>
      request<{ templates: Template[] }>(
        "/templates",
        body("POST", { workspace: workspaceId, template, ...(scope ? { scope } : {}) }),
      ).then((r) => r.templates),
    /** A built-in id saves a copy in the Workspace; `everywhere` changes every copy of a shared one. */
    update: (workspaceId: Id, id: Id, template: TemplateInput, everywhere = false) =>
      request<{ templates: Template[] }>(
        `/templates/${encodeURIComponent(id)}`,
        body("PUT", { workspace: workspaceId, template, everywhere }),
      ).then((r) => r.templates),
    remove: (id: Id, everywhere = false) =>
      request<{ removed: Template[] }>(
        `/templates/${encodeURIComponent(id)}${everywhere ? "?everywhere=1" : ""}`,
        { method: "DELETE" },
      ).then((r) => r.removed),
    /** Undo of a delete: the same rows back. */
    restore: (ids: readonly Id[]) =>
      request<{ templates: Template[] }>("/templates/restore", body("POST", { ids })).then(
        (r) => r.templates,
      ),
    fill: (workspaceId: Id, id: Id, from: { threadId: Id | null; to?: Person[] }) =>
      request<TemplateFillResult>(
        `/templates/${encodeURIComponent(id)}/fill`,
        body("POST", { workspace: workspaceId, threadId: from.threadId, to: from.to ?? [] }),
      ),
    exportFiles: (workspaceId: Id) =>
      request<{ files: TemplateFile[] }>(
        `/templates/export?${new URLSearchParams({ workspace: workspaceId })}`,
      ).then((r) => r.files),
    importFiles: (workspaceId: Id, files: readonly TemplateFile[], scope?: TemplateScope) =>
      request<{ created: Template[]; errors: Array<{ file: string; message: string }> }>(
        "/templates/import",
        body("POST", { workspace: workspaceId, files, ...(scope ? { scope } : {}) }),
      ),
  };
}

export type TemplatesApi = ReturnType<typeof templatesApi>;
