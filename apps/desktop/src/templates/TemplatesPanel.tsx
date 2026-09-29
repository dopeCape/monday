// Settings › Templates (docs/spec/templates.md): browse the Workspace's own
// Templates and the built-ins, write a new one, edit one (a built-in saves a
// copy; a shared one asks "Change it everywhere" or "Only here"), delete with
// Undo, Restore the original, hide a built-in (templates.builtin.hidden), and
// Export and Import Markdown files on request. Talks to the Server's routes;
// the Cache follows through the Changes feed.

import type {
  Placeholder,
  PlaceholderType,
  Template,
  TemplateInput,
  TemplateScope,
} from "@monday/shared";
import { BUILTIN_TEMPLATES, PLACEHOLDER_TYPES, templateErrors, tidyTemplate } from "@monday/shared";
import { Btn, Input, Seg, Select, Switch, Tag } from "@monday/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  messageOf,
  type PanelProps,
  registerPanel,
  useSettingsScreen,
} from "../screens/settings/render.tsx";
import { useShell } from "../shell/Shell.tsx";
import { readTemplateFiles, saveTemplateFiles } from "./files.ts";
import { blankTemplate, placeholdersFor } from "./form.ts";
import { fillIn, type TemplateUiStrings, templateStrings } from "./strings.ts";

export type Editing =
  | { kind: "new"; input: TemplateInput }
  | { kind: "edit"; template: Template; input: TemplateInput };

const inputOf = (t: Template): TemplateInput => ({
  name: t.name,
  fitsWhen: t.fitsWhen,
  kind: t.kind,
  subject: t.subject,
  body: t.body,
  placeholders: t.placeholders,
});

export function TemplatesPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const strings = useMemo(() => templateStrings(s), [s]);
  const workspaceId = screen.workspaceId;
  const [own, setOwn] = useState<Template[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const hidden = s["templates.builtin.hidden"];

  const load = useCallback(async () => {
    try {
      setOwn(await shell.api.templates.list(workspaceId));
      setError(null);
    } catch (e) {
      setOwn([]);
      setError(fillIn(strings.loadFailed, { message: messageOf(e) }));
    }
  }, [shell.api, workspaceId, strings.loadFailed]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    try {
      setError(null);
      await action();
    } catch (e) {
      setError(fillIn(strings.failed, { message: messageOf(e) }));
    }
  };

  const copies = new Map((own ?? []).flatMap((t) => (t.builtIn ? [[t.builtIn, t] as const] : [])));

  const remove = (t: Template) =>
    run(async () => {
      const removed = await shell.api.templates.remove(t.id);
      await load();
      setNotice({
        text: fillIn(strings.deleted, { name: t.name }),
        undo: () =>
          void run(async () => {
            await shell.api.templates.restore(removed.map((r) => r.id));
            setNotice(null);
            await load();
          }),
      });
    });

  const setHidden = (id: string, hide: boolean) =>
    void shell.set(
      "templates.builtin.hidden",
      hide ? [...new Set([...hidden, id])] : hidden.filter((h) => h !== id),
    );

  const exportAll = () =>
    run(async () => {
      const files = await shell.api.templates.exportFiles(workspaceId);
      const folder = await saveTemplateFiles(files, new Date());
      setNotice({ text: fillIn(strings.exported, { n: files.length, folder }) });
    });

  const importFrom = (list: File[]) =>
    run(async () => {
      const files = await readTemplateFiles(list);
      const result = await shell.api.templates.importFiles(workspaceId, files);
      setImportErrors(
        result.errors.map((e) =>
          fillIn(strings.importFailed, { file: e.file, message: e.message }),
        ),
      );
      setNotice({ text: fillIn(strings.imported, { n: result.created.length }) });
      await load();
    });

  const save = async (
    input: TemplateInput,
    how: { scope?: TemplateScope; everywhere?: boolean },
  ) => {
    if (!editing) return;
    await run(async () => {
      if (editing.kind === "new") {
        await shell.api.templates.create(workspaceId, input, how.scope);
      } else {
        await shell.api.templates.update(
          workspaceId,
          editing.template.id,
          input,
          how.everywhere ?? false,
        );
      }
      setEditing(null);
      await load();
    });
  };

  if (editing) {
    return (
      <TemplateForm
        editing={editing}
        strings={strings}
        defaultScope={s["templates.default_scope"]}
        onSave={save}
        onCancel={() => setEditing(null)}
        error={error}
      />
    );
  }

  const builtinRow = (t: Template) => {
    const copy = copies.get(t.id);
    const isHidden = hidden.includes(t.id);
    return (
      <div className="tpl-row" key={t.id} data-template={t.id} data-hidden={isHidden || undefined}>
        <div className="tpl-row-text">
          <b>{copy?.name ?? t.name}</b>
          <span>{copy?.fitsWhen ?? t.fitsWhen}</span>
        </div>
        <span className="tpl-badges">
          <Tag>{copy ? strings.badgeEdited : strings.badgeBuiltin}</Tag>
        </span>
        <span className="tpl-actions">
          <Btn
            sm
            onClick={() =>
              setEditing({ kind: "edit", template: copy ?? t, input: inputOf(copy ?? t) })
            }
          >
            {strings.edit}
          </Btn>
          {copy ? (
            <Btn
              sm
              onClick={() =>
                void run(async () => {
                  await shell.api.templates.remove(copy.id);
                  await load();
                })
              }
            >
              {strings.restore}
            </Btn>
          ) : (
            <Btn sm onClick={() => setHidden(t.id, !isHidden)}>
              {isHidden ? strings.show : strings.hide}
            </Btn>
          )}
        </span>
      </div>
    );
  };

  const ownRow = (t: Template) => (
    <div className="tpl-row" key={t.id} data-template={t.id}>
      <div className="tpl-row-text">
        <b>{t.name}</b>
        <span>{t.fitsWhen}</span>
      </div>
      <span className="tpl-badges">
        {t.shareGroupId ? <Tag>{strings.badgeEverywhere}</Tag> : null}
        {t.createdBy === "agent" ? <Tag kind="ai">{strings.badgeAgent}</Tag> : null}
      </span>
      <span className="tpl-actions">
        <Btn sm onClick={() => setEditing({ kind: "edit", template: t, input: inputOf(t) })}>
          {strings.edit}
        </Btn>
        <Btn sm onClick={() => void remove(t)}>
          {strings.delete}
        </Btn>
      </span>
    </div>
  );

  const mine = (own ?? []).filter((t) => !t.builtIn);
  return (
    <Card
      title={strings.title}
      hint={strings.hint}
      block
      attrs={{ "data-panel": "templates" }}
      foot={error ? <span className="err">{error}</span> : undefined}
    >
      <div className="tpl-panel">
        <div className="tpl-bar">
          <Btn sm primary onClick={() => setEditing({ kind: "new", input: blankTemplate() })}>
            {strings.newTemplate}
          </Btn>
          <span className="sp" />
          <Btn sm onClick={() => void exportAll()}>
            {strings.export}
          </Btn>
          <Btn sm onClick={() => fileInput.current?.click()}>
            {strings.import}
          </Btn>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".md,.markdown,text/markdown"
            hidden
            aria-label={strings.import}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) void importFrom(files);
            }}
          />
        </div>
        {notice ? (
          <div className="tpl-notice" role="status">
            {notice.text}
            {notice.undo ? (
              <Btn sm onClick={notice.undo}>
                {strings.undo}
              </Btn>
            ) : null}
          </div>
        ) : null}
        {importErrors.map((line) => (
          <div className="tpl-notice err" key={line}>
            {line}
          </div>
        ))}
        <div className="tpl-list">
          {own !== null && mine.length === 0 ? <div className="note">{strings.empty}</div> : null}
          {mine.map(ownRow)}
        </div>
        <div className="tpl-list builtin">
          {hidden.length > 0 ? (
            <div className="note">{fillIn(strings.hiddenCount, { n: hidden.length })}</div>
          ) : null}
          {BUILTIN_TEMPLATES.map(builtinRow)}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------ The form ------------------------------ */

export interface TemplateFormProps {
  editing: Editing;
  strings: TemplateUiStrings;
  defaultScope: TemplateScope;
  error: string | null;
  onSave(input: TemplateInput, how: { scope?: TemplateScope; everywhere?: boolean }): void;
  onCancel(): void;
}

export function TemplateForm({
  editing,
  strings,
  defaultScope,
  error,
  onSave,
  onCancel,
}: TemplateFormProps) {
  const [input, setInput] = useState<TemplateInput>(editing.input);
  const [everywhere, setEverywhere] = useState(defaultScope === "everywhere");
  const [asking, setAsking] = useState(false);
  const shared = editing.kind === "edit" && editing.template.shareGroupId !== null;
  const tidy = tidyTemplate(input);
  const errors = templateErrors(tidy);

  const change = (patch: Partial<TemplateInput>) =>
    setInput((prev) => {
      const next = { ...prev, ...patch };
      return { ...next, placeholders: placeholdersFor(next, prev.placeholders) };
    });
  const setPlaceholder = (name: string, patch: Partial<Placeholder>) =>
    setInput((prev) => ({
      ...prev,
      placeholders: prev.placeholders.map((p) => (p.name === name ? { ...p, ...patch } : p)),
    }));

  const typeOptions = PLACEHOLDER_TYPES.map((t) => ({ value: t, label: strings.types[t] }));
  const submit = () => {
    if (errors.length > 0) return;
    if (editing.kind === "new") onSave(tidy, { scope: everywhere ? "everywhere" : "workspace" });
    else if (shared) setAsking(true);
    else onSave(tidy, {});
  };

  return (
    <div className="scard block tpl-form" data-panel="templates" data-editing={editing.kind}>
      <div className="tpl-field">
        <label htmlFor="tpl-name">{strings.fieldName}</label>
        <Input
          id="tpl-name"
          value={input.name}
          onChange={(e) => change({ name: e.target.value })}
        />
      </div>
      <div className="tpl-field">
        <label htmlFor="tpl-fits">{strings.fieldFitsWhen}</label>
        <Input
          id="tpl-fits"
          value={input.fitsWhen}
          onChange={(e) => change({ fitsWhen: e.target.value })}
        />
      </div>
      <div className="tpl-field">
        <span>{strings.fieldKind}</span>
        <Seg
          options={[
            { value: "reply", label: strings.kindReply },
            { value: "starter", label: strings.kindStarter },
          ]}
          value={input.kind}
          onChange={(kind) =>
            change({ kind, subject: kind === "starter" ? (input.subject ?? "") : null })
          }
        />
      </div>
      {input.kind === "starter" ? (
        <div className="tpl-field">
          <label htmlFor="tpl-subject">{strings.fieldSubject}</label>
          <Input
            id="tpl-subject"
            value={input.subject ?? ""}
            onChange={(e) => change({ subject: e.target.value })}
          />
        </div>
      ) : null}
      <label className="tpl-field">
        <span>{strings.fieldBody}</span>
        <textarea
          className="input tpl-body"
          rows={8}
          value={input.body}
          onChange={(e) => change({ body: e.target.value })}
        />
        <small className="scard-hint">{strings.fieldBodyHint}</small>
      </label>
      {input.placeholders.length > 0 ? (
        <div className="tpl-field">
          <span>{strings.fieldPlaceholders}</span>
          <div className="tpl-phs">
            {input.placeholders.map((p) => (
              <div className="tpl-ph" key={p.name} data-placeholder={p.name}>
                <code>{`{${p.name}${p.optional ? "?" : ""}}`}</code>
                <Select<PlaceholderType>
                  label={strings.types[p.type]}
                  value={p.type}
                  options={typeOptions}
                  onChange={(type) => setPlaceholder(p.name, { type })}
                />
                <Input
                  aria-label={strings.fieldHint}
                  placeholder={strings.fieldHint}
                  value={p.hint}
                  onChange={(e) => setPlaceholder(p.name, { hint: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {editing.kind === "new" ? (
        <div className="tpl-field row">
          <Switch on={everywhere} onChange={setEverywhere} label={strings.useEverywhere} />
          <span>{strings.useEverywhere}</span>
        </div>
      ) : null}
      {errors.length > 0 && input.name.trim() ? (
        <div className="tpl-notice err">
          {fillIn(strings.invalid, { errors: errors.join(" ") })}
        </div>
      ) : null}
      {error ? <div className="tpl-notice err">{error}</div> : null}
      {asking ? (
        <div className="tpl-notice" role="alertdialog" aria-label={strings.changeWhere}>
          {strings.changeWhere}
          <Btn sm primary onClick={() => onSave(tidy, { everywhere: true })}>
            {strings.changeEverywhere}
          </Btn>
          <Btn sm onClick={() => onSave(tidy, { everywhere: false })}>
            {strings.onlyHere}
          </Btn>
        </div>
      ) : null}
      <div className="tpl-bar">
        <Btn sm primary disabled={errors.length > 0} onClick={submit}>
          {strings.save}
        </Btn>
        <Btn sm onClick={onCancel}>
          {strings.cancel}
        </Btn>
      </div>
    </div>
  );
}

registerPanel("accounts", "Templates", TemplatesPanel, {
  title: "strings.templates.title",
  description: "strings.templates.hint",
  searchTerms: [
    "templates",
    "canned",
    "snippets",
    "saved replies",
    "placeholders",
    "export",
    "import",
  ],
});
