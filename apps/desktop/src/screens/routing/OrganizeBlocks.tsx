// The Sections block and the Actions block (docs/spec/settings.md "Routing":
// Sections user-defined, custom actions per Group or Section), shared by the
// Routing page and the Settings Routing section. Both edit Settings
// (sections.rules, sections.order, actions.custom; ADR 0004) through the
// callbacks the host page hands in, so the same rows the Agent writes with
// create_section and create_action are the ones the user edits here, and
// "Ask monday" hands a sentence to the composer. Every string is a Setting.

import type { CustomActionSetting, SectionRuleSetting, Settings } from "@monday/shared";
import {
  CUSTOM_ACTION_TOOLS,
  customActionIdFor,
  isSettingKey,
  orderedSectionRules,
  sectionLabel,
  TOOL_TIERS,
  tierOf,
} from "@monday/shared";
import { Btn, Input, Seg, Switch, Tag } from "@monday/ui";
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { fill } from "../inbox/triage.ts";

/** A one-line "Ask monday" row: the sentence typed goes to the composer with the prompt around it. */
function AskRow({
  settings,
  label,
  placeholder,
  prompt,
  onAsk,
}: {
  settings: Settings;
  label: string;
  placeholder: string;
  prompt: string;
  onAsk: ((text: string) => void) | undefined;
}) {
  const [text, setText] = useState("");
  if (!onAsk || settings["ai.level"] === "off") return null;
  const send = () => {
    if (!text.trim()) return;
    onAsk(fill(prompt, { text: text.trim() }));
    setText("");
  };
  return (
    <div className="set-ask">
      <div>
        <b>{label}</b>
        <span className="set-ask-row">
          <Input
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
          />
          <Btn sm primary disabled={!text.trim()} onClick={send}>
            {settings["strings.settings.ask.send"]}
          </Btn>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ Sections ------------------------------ */

export interface SectionsBlockProps {
  settings: Settings;
  rules: readonly SectionRuleSetting[];
  order: readonly string[];
  /** Writes both Settings; the host page decides the seam (the Shell, or the Settings screen). */
  onChange: (rules: SectionRuleSetting[], order: string[]) => unknown;
  /** Renames a shipped Section through its strings.section.<id> Setting. */
  onRenameString?: ((key: string, name: string) => unknown) | undefined;
  onAsk?: ((text: string) => void) | undefined;
  /** Rendered with a heading (the Routing page) or bare inside a Settings row. */
  heading?: boolean | undefined;
}

export function sectionNameOf(settings: Settings, rule: SectionRuleSetting): string {
  const key = `strings.section.${rule.id}`;
  return sectionLabel(rule, isSettingKey(key) ? String(settings[key]) : undefined);
}

function describeWhen(when: SectionRuleSetting["when"], s: Settings): string {
  const n = Object.keys(when).length;
  return fill(s["strings.settings.sections.conditions"], { n });
}

export function SectionsBlock({
  settings: s,
  rules,
  order,
  onChange,
  onRenameString,
  onAsk,
  heading,
}: SectionsBlockProps) {
  const ordered = orderedSectionRules(rules, order);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [judging, setJudging] = useState<{ id: string; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const update = (id: string, patch: Partial<SectionRuleSetting>) =>
    void onChange(
      rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      [...order],
    );
  const move = (id: string, by: -1 | 1) => {
    const ids = ordered.map((r) => r.id);
    const at = ids.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(at, 1);
    next.splice(to, 0, id);
    void onChange([...rules], next);
  };
  const remove = (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setConfirmDelete(null);
    void onChange(
      rules.filter((r) => r.id !== id),
      order.filter((x) => x !== id),
    );
  };
  const rename = (r: SectionRuleSetting, name: string) => {
    const key = `strings.section.${r.id}`;
    if (!r.name && isSettingKey(key) && onRenameString) void onRenameString(key, name);
    else update(r.id, { name });
  };
  const byWord = (r: SectionRuleSetting) =>
    r.createdBy === "shipped"
      ? s["strings.settings.sections.shipped"]
      : r.createdBy === "agent"
        ? s["strings.settings.sections.by_agent"]
        : r.createdBy === "user"
          ? s["strings.settings.sections.by_user"]
          : null;
  return (
    <div className="organize-block" data-block="sections">
      {heading ? <h3>{s["strings.settings.sections.title"]}</h3> : null}
      <div className="set-rules" data-setting="sections.order">
        {ordered.length === 0 ? (
          <p className="faint">{s["strings.settings.sections.empty"]}</p>
        ) : null}
        {ordered.map((r, i) => {
          const name = sectionNameOf(s, r);
          const by = byWord(r);
          return (
            <div className={`set-rule ${r.hidden ? "off" : ""}`} key={r.id} data-rule={r.id}>
              <div>
                {renaming?.id === r.id ? (
                  <Input
                    value={renaming.name}
                    autoFocus
                    onChange={(e) => setRenaming({ id: r.id, name: e.target.value })}
                    onBlur={() => {
                      if (renaming.name.trim()) rename(r, renaming.name.trim());
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <b>
                    {name}
                    {by ? <Tag>{by}</Tag> : null}
                  </b>
                )}
                {r.sentence ? (
                  <span>
                    {s["strings.settings.sections.sentence"]}: {r.sentence}
                  </span>
                ) : null}
                <span>{describeWhen(r.when, s)}</span>
                {judging?.id === r.id ? (
                  <Input
                    value={judging.text}
                    autoFocus
                    placeholder={s["strings.settings.sections.judge"]}
                    onChange={(e) => setJudging({ id: r.id, text: e.target.value })}
                    onBlur={() => {
                      const text = judging.text.trim();
                      update(r.id, text ? { judge: text } : { judge: undefined });
                      setJudging(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setJudging(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="link faint judge-line"
                    onClick={() => setJudging({ id: r.id, text: r.judge ?? "" })}
                  >
                    {r.judge
                      ? `${s["strings.settings.sections.judge"]}: ${r.judge}`
                      : s["strings.settings.sections.judge"]}
                  </button>
                )}
                <span className="rule-placement">
                  {s["strings.settings.sections.placement"]}
                  <Seg
                    options={[
                      { value: "stream", label: s["strings.settings.sections.placement.stream"] },
                      { value: "nav", label: s["strings.settings.sections.placement.nav"] },
                      { value: "both", label: s["strings.settings.sections.placement.both"] },
                    ]}
                    value={r.placement ?? "stream"}
                    onChange={(value) =>
                      update(r.id, { placement: value as SectionRuleSetting["placement"] })
                    }
                  />
                </span>
              </div>
              <Btn
                sm
                icon
                aria-label={s["strings.settings.sections.up"]}
                disabled={i === 0}
                onClick={() => move(r.id, -1)}
              >
                <ArrowUpIcon />
              </Btn>
              <Btn
                sm
                icon
                aria-label={s["strings.settings.sections.down"]}
                disabled={i === ordered.length - 1}
                onClick={() => move(r.id, 1)}
              >
                <ArrowDownIcon />
              </Btn>
              <Btn sm onClick={() => setRenaming({ id: r.id, name })}>
                {s["strings.settings.views.rename"]}
              </Btn>
              <span className="rule-hide">
                <span>{s["strings.settings.sections.hidden"]}</span>
                <Switch on={Boolean(r.hidden)} onChange={(hidden) => update(r.id, { hidden })} />
                <Btn
                  sm
                  className={confirmDelete === r.id ? "danger" : undefined}
                  onClick={() => remove(r.id)}
                >
                  {confirmDelete === r.id
                    ? fill(s["strings.settings.sections.delete_confirm"], { name })
                    : s["strings.settings.sections.delete"]}
                </Btn>
              </span>
            </div>
          );
        })}
      </div>
      <AskRow
        settings={s}
        label={s["strings.settings.sections.ask"]}
        placeholder={s["strings.settings.sections.ask_placeholder"]}
        prompt={s["strings.settings.sections.ask_prompt"]}
        onAsk={onAsk}
      />
    </div>
  );
}

/* ------------------------------ Actions ------------------------------ */

export interface ActionsBlockProps {
  settings: Settings;
  actions: readonly CustomActionSetting[];
  onChange: (actions: CustomActionSetting[]) => unknown;
  /** Group ids to names, for the condition picker. */
  groups: ReadonlyArray<{ id: string; name: string }>;
  /** Section ids to names, for the condition picker. */
  sections: ReadonlyArray<{ id: string; name: string }>;
  onAsk?: ((text: string) => void) | undefined;
  heading?: boolean | undefined;
}

type OnKind = "any" | "group" | "section" | "judge";

interface ActionDraft {
  id: string | null;
  label: string;
  onKind: OnKind;
  onValue: string;
  tool: string;
  args: string;
  alwaysAsk: boolean;
}

function draftOf(a: CustomActionSetting | null): ActionDraft {
  const onKind: OnKind = a?.on.group
    ? "group"
    : a?.on.section
      ? "section"
      : a?.on.judge
        ? "judge"
        : "any";
  return {
    id: a?.id ?? null,
    label: a?.label ?? "",
    onKind,
    onValue: a?.on.group ?? a?.on.section ?? a?.on.judge ?? "",
    tool: a?.tool ?? "forward_thread",
    args: JSON.stringify(a?.args ?? {}, null, 2),
    alwaysAsk: a?.tier === "always-ask",
  };
}

/** The Tier an action renders with, worded from Settings. */
export function actionTierWord(a: CustomActionSetting, s: Settings): string {
  const base = TOOL_TIERS[a.tool];
  const tier = a.tier === "always-ask" || !base ? "always-ask" : tierOf(base);
  return tier === "always-ask"
    ? s["strings.actions.tier.always_ask"]
    : tier === "reversible"
      ? s["strings.actions.tier.reversible"]
      : s["strings.actions.tier.read_only"];
}

export function actionOnWord(
  a: CustomActionSetting,
  s: Settings,
  groups: ActionsBlockProps["groups"],
  sections: ActionsBlockProps["sections"],
): string {
  if (a.on.group) {
    const g = groups.find((x) => x.id === a.on.group || x.name === a.on.group);
    return `${s["strings.actions.on_group"]} ${g?.name ?? a.on.group}`;
  }
  if (a.on.section) {
    const sec = sections.find((x) => x.id === a.on.section);
    return `${s["strings.actions.on_section"]} ${sec?.name ?? a.on.section}`;
  }
  if (a.on.judge) return `${s["strings.actions.on_judge"]} "${a.on.judge}"`;
  return s["strings.actions.on_any"];
}

export function ActionsBlock({
  settings: s,
  actions,
  onChange,
  groups,
  sections,
  onAsk,
  heading,
}: ActionsBlockProps) {
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!draft?.label.trim()) return;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(draft.args || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
      args = parsed as Record<string, unknown>;
    } catch {
      setError(s["strings.actions.args_invalid"]);
      return;
    }
    const on: CustomActionSetting["on"] = {};
    const value = draft.onValue.trim();
    if (draft.onKind === "group" && value) on.group = value;
    if (draft.onKind === "section" && value) on.section = value;
    if (draft.onKind === "judge" && value) on.judge = value;
    const next: CustomActionSetting = {
      id:
        draft.id ??
        customActionIdFor(
          draft.label,
          actions.map((a) => a.id),
        ),
      label: draft.label.trim(),
      on,
      tool: draft.tool,
      args,
      ...(draft.alwaysAsk ? { tier: "always-ask" as const } : {}),
      createdBy: "user",
    };
    setError(null);
    setDraft(null);
    void onChange(
      draft.id ? actions.map((a) => (a.id === draft.id ? next : a)) : [...actions, next],
    );
  };
  const remove = (id: string) => void onChange(actions.filter((a) => a.id !== id));
  return (
    <div className="organize-block" data-block="actions">
      {heading ? <h3>{s["strings.actions.title"]}</h3> : null}
      <div className="set-rules" data-setting="actions.custom">
        {actions.length === 0 ? <p className="faint">{s["strings.actions.empty"]}</p> : null}
        {actions.map((a) => (
          <div className="set-rule" key={a.id} data-action={a.id}>
            <div>
              <b>{a.label}</b>
              <span>
                {fill(s["strings.actions.line"], {
                  tool: a.tool,
                  on: actionOnWord(a, s, groups, sections),
                  tier: actionTierWord(a, s),
                })}
              </span>
            </div>
            <Btn sm onClick={() => setDraft(draftOf(a))}>
              {s["strings.actions.edit"]}
            </Btn>
            <Btn sm onClick={() => remove(a.id)}>
              {s["strings.actions.remove"]}
            </Btn>
          </div>
        ))}
      </div>
      {draft ? (
        <div className="rule-edit" data-editing={draft.id ?? "new"}>
          <label>
            <span>{s["strings.actions.label"]}</span>
            <input
              className="input"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.currentTarget.value })}
            />
          </label>
          <div className="rule-edit-row">
            <span>{s["strings.actions.on"]}</span>
            <Seg
              options={[
                { value: "any", label: s["strings.actions.on_any"] },
                { value: "group", label: s["strings.actions.on_group"] },
                { value: "section", label: s["strings.actions.on_section"] },
                { value: "judge", label: s["strings.actions.on_judge"] },
              ]}
              value={draft.onKind}
              onChange={(value) => setDraft({ ...draft, onKind: value as OnKind, onValue: "" })}
            />
          </div>
          {draft.onKind === "group" ? (
            <label>
              <span>{s["strings.actions.on_group"]}</span>
              <select
                className="select"
                value={draft.onValue}
                onChange={(e) => setDraft({ ...draft, onValue: e.currentTarget.value })}
              >
                <option value="">{s["strings.settings.groups.none"]}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {draft.onKind === "section" ? (
            <label>
              <span>{s["strings.actions.on_section"]}</span>
              <select
                className="select"
                value={draft.onValue}
                onChange={(e) => setDraft({ ...draft, onValue: e.currentTarget.value })}
              >
                <option value="" />
                {sections.map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {sec.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {draft.onKind === "judge" ? (
            <label>
              <span>{s["strings.actions.on_judge"]}</span>
              <input
                className="input"
                value={draft.onValue}
                onChange={(e) => setDraft({ ...draft, onValue: e.currentTarget.value })}
              />
            </label>
          ) : null}
          <label>
            <span>{s["strings.actions.tool"]}</span>
            <select
              className="select"
              value={draft.tool}
              onChange={(e) => setDraft({ ...draft, tool: e.currentTarget.value })}
            >
              {CUSTOM_ACTION_TOOLS.map((tool) => (
                <option key={tool} value={tool}>
                  {tool}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{s["strings.actions.args"]}</span>
            <textarea
              className="input"
              rows={3}
              value={draft.args}
              onChange={(e) => setDraft({ ...draft, args: e.currentTarget.value })}
            />
          </label>
          <div className="rule-edit-row">
            <span>{s["strings.actions.promote"]}</span>
            <Switch
              on={draft.alwaysAsk}
              onChange={(alwaysAsk) => setDraft({ ...draft, alwaysAsk })}
            />
          </div>
          {error ? (
            <p className="faint" role="alert">
              {error}
            </p>
          ) : null}
          <div className="acts">
            <Btn sm primary onClick={save} disabled={!draft.label.trim()}>
              {s["strings.actions.save"]}
            </Btn>
            <Btn
              sm
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              {s["strings.actions.cancel"]}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="acts">
          <Btn sm onClick={() => setDraft(draftOf(null))}>
            {s["strings.actions.add"]}
          </Btn>
        </div>
      )}
      <AskRow
        settings={s}
        label={s["strings.actions.ask"]}
        placeholder={s["strings.actions.ask_placeholder"]}
        prompt={s["strings.actions.ask_prompt"]}
        onAsk={onAsk}
      />
    </div>
  );
}
