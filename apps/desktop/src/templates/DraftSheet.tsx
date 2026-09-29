// Writing a Template from examples (docs/spec/templates.md): "Make a template
// from this" on a sent Message and "Save as template" in compose open this
// sheet. The Server's language model drafts the Template and the judge checks
// for a duplicate; the sheet shows the rendered Template with its
// Placeholders as chips and Save, Edit, Cancel. A duplicate at "same" reads
// "You already have …" with Replace it, Keep both, Cancel; "related" reads
// "Similar to …" with both side by side. Saving is reversible: Undo deletes it.

import type { Template, TemplateDraftResult, TemplateInput, TemplateScope } from "@monday/shared";
import { Btn, Tag, useEscape } from "@monday/ui";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TemplatesApi } from "./api.ts";
import { TemplateBody } from "./Body.tsx";
import type { TemplateDraftSource } from "./link.ts";
import { fillIn, type TemplateUiStrings } from "./strings.ts";
import { TemplateForm } from "./TemplatesPanel.tsx";

type Phase =
  | { kind: "drafting" }
  | { kind: "ready"; result: TemplateDraftResult; existing: Template | null }
  | { kind: "editing"; result: TemplateDraftResult }
  | { kind: "saved"; name: string; ids: string[] }
  | { kind: "failed"; message: string };

export interface TemplateDraftSheetProps {
  workspaceId: string;
  source: TemplateDraftSource;
  api: TemplatesApi;
  strings: TemplateUiStrings;
  defaultScope: TemplateScope;
  onClose(): void;
}

function Card({ template, strings }: { template: TemplateInput; strings: TemplateUiStrings }) {
  return (
    <div className="tpl-card" data-template-name={template.name}>
      <b>{template.name}</b>
      {template.fitsWhen ? <span className="tpl-fit">{template.fitsWhen}</span> : null}
      {template.subject ? <div className="tpl-subject">{template.subject}</div> : null}
      <TemplateBody body={template.body} placeholders={template.placeholders} />
      {template.placeholders.length ? (
        <div className="tpl-card-phs">
          {template.placeholders.map((p) => (
            <Tag key={p.name}>{`${p.name.replaceAll("_", " ")}: ${strings.types[p.type]}`}</Tag>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TemplateDraftSheet({
  workspaceId,
  source,
  api,
  strings,
  defaultScope,
  onClose,
}: TemplateDraftSheetProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "drafting" });
  useEscape(onClose);

  useEffect(() => {
    let live = true;
    api
      .draft(
        workspaceId,
        "messageIds" in source ? { messageIds: source.messageIds } : { texts: source.texts },
      )
      .then(async (result) => {
        const existing = result.duplicate
          ? await api.get(result.duplicate.templateId).catch(() => null)
          : null;
        if (live) setPhase({ kind: "ready", result, existing });
      })
      .catch((e: unknown) => {
        if (live) setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [api, workspaceId, source]);

  const save = async (input: TemplateInput, scope?: TemplateScope) => {
    try {
      const made = await api.create(workspaceId, input, scope);
      setPhase({ kind: "saved", name: input.name, ids: made.map((t) => t.id) });
    } catch (e) {
      setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const replace = async (input: TemplateInput, id: string) => {
    try {
      const written = await api.update(workspaceId, id, input);
      setPhase({ kind: "saved", name: input.name, ids: written.map((t) => t.id) });
    } catch (e) {
      setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  let body: ReactNode;
  switch (phase.kind) {
    case "drafting":
      body = <div className="tpl-notice">{strings.drafting}</div>;
      break;
    case "failed":
      body = (
        <>
          <div className="tpl-notice err">
            {fillIn(strings.draftFailed, { message: phase.message })}
          </div>
          <div className="tpl-bar">
            <Btn sm onClick={onClose}>
              {strings.cancel}
            </Btn>
          </div>
        </>
      );
      break;
    case "saved":
      body = (
        <div className="tpl-notice" role="status">
          {fillIn(strings.saved, { name: phase.name })}
          <Btn
            sm
            onClick={() => void Promise.all(phase.ids.map((id) => api.remove(id))).finally(onClose)}
          >
            {strings.undo}
          </Btn>
          <Btn sm primary onClick={onClose}>
            {strings.cancel}
          </Btn>
        </div>
      );
      break;
    case "editing":
      body = (
        <TemplateForm
          editing={{ kind: "new", input: phase.result.template }}
          strings={strings}
          defaultScope={defaultScope}
          error={null}
          onSave={(input, how) => void save(input, how.scope)}
          onCancel={onClose}
        />
      );
      break;
    case "ready": {
      const { template, duplicate } = phase.result;
      const same = duplicate?.level === "same";
      body = (
        <>
          {duplicate ? (
            <div className="tpl-notice" data-duplicate={duplicate.level}>
              {fillIn(same ? strings.duplicateSame : strings.duplicateRelated, {
                name: duplicate.name,
              })}
            </div>
          ) : null}
          <div className={duplicate && !same ? "tpl-side" : undefined}>
            <Card template={template} strings={strings} />
            {duplicate && !same && phase.existing ? (
              <Card template={phase.existing} strings={strings} />
            ) : null}
          </div>
          <div className="tpl-bar">
            {same && duplicate ? (
              <>
                <Btn sm primary onClick={() => void replace(template, duplicate.templateId)}>
                  {strings.duplicateReplace}
                </Btn>
                <Btn sm onClick={() => void save(template, defaultScope)}>
                  {strings.duplicateKeep}
                </Btn>
              </>
            ) : (
              <>
                <Btn sm primary onClick={() => void save(template, defaultScope)}>
                  {strings.save}
                </Btn>
                <Btn sm onClick={() => setPhase({ kind: "editing", result: phase.result })}>
                  {strings.edit}
                </Btn>
              </>
            )}
            <Btn sm onClick={onClose}>
              {strings.cancel}
            </Btn>
          </div>
        </>
      );
      break;
    }
  }

  return createPortal(
    <div className="mcp-scrim tpl-scrim">
      <div className="mcp-dialog tpl-dialog" role="dialog" aria-label={strings.title}>
        <div className="mcp-head">
          <span />
          <div>
            <h3>{strings.title}</h3>
          </div>
          <span />
        </div>
        <div className="tpl-dialog-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
