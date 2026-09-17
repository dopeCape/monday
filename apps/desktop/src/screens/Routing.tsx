// The Routing page (docs/spec/settings.md "Routing"; design/js/screens/
// routing.js): the Groups tree with each rule, Sub-groups, unread counts and
// Confidence; the Needs a decision queue with accept or leave; "Recently
// routed"; and the re-run with preview, which asks the Server for a dry run
// and applies only on the second click. Groups and decisions come from the
// Store (the feed keeps them current); Examples, Confidence and the actions
// go through the API. Every string is a Setting (strings.routing.*).

import type { GroupInput, GroupView, Predicate, ProposedMove, Settings } from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AskBox,
  Btn,
  DecisionRow,
  GroupCard,
  PageHead,
  PreviewCard,
  SampleRow,
  Seg,
  SideCard,
  type SubgroupItem,
} from "@monday/ui";
import { groupConfidence, groupIcon, workspace } from "@monday/ui/fixtures";
import { ArrowsClockwiseIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Api } from "../platform/api.ts";
import { useShell } from "../shell/Shell.tsx";
import { fixtureInbox, type InboxSource } from "./inbox/actions.ts";
import { fill } from "./inbox/triage.ts";
import { fixtureRouting, type RoutingSource } from "./routing/routing-data.ts";

export interface RoutingProps {
  /** Groups and Needs a decision; the Store's implementation in the app, fixtures in tests. */
  routing?: RoutingSource | undefined;
  /** The stream, for unread counts and "Recently routed". */
  inbox?: InboxSource | undefined;
  workspaceId?: string | undefined;
  /** Opens a Group in the inbox. */
  onNavigate?: ((target: string) => void) | undefined;
  /** The Server side of the page; the Shell's client by default, a fake in tests. */
  api?: RoutingApi | undefined;
}

export type RoutingApi = Api["routing"];

const defaultRouting = fixtureRouting();
const defaultInbox = fixtureInbox();

type Strings = Record<string, string>;

function routingStrings(settings: Settings): Strings {
  const out: Strings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("strings.routing.") && typeof value === "string") {
      out[key.slice("strings.routing.".length)] = value;
    }
  }
  return out;
}

/** The first name in "Name <email>" style, for an avatar. */
const nameOf = (p: { name: string; email: string } | null | undefined) =>
  p ? p.name || p.email : "?";

const list = (values: readonly string[] | undefined) => (values ?? []).join(", ");
const split = (value: string) =>
  value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

interface Draft {
  name: string;
  sentence: string;
  domains: string;
  senders: string;
  subjects: string;
  lists: string;
  threshold: string;
  briefPolicy: "default" | "always" | "on_open" | "never";
}

function draftOf(g: {
  name: string;
  rule: { sentence: string; predicate: Predicate };
  threshold: number | null;
  briefPolicy: string | null;
}): Draft {
  return {
    name: g.name,
    sentence: g.rule.sentence,
    domains: list(g.rule.predicate.domains),
    senders: list(g.rule.predicate.senders),
    subjects: list(g.rule.predicate.subjectPatterns),
    lists: list(g.rule.predicate.listIds),
    threshold: g.threshold === null ? "" : String(g.threshold),
    briefPolicy:
      g.briefPolicy === "always" || g.briefPolicy === "on_open" || g.briefPolicy === "never"
        ? g.briefPolicy
        : "default",
  };
}

function inputOf(d: Draft): GroupInput {
  const predicate: Predicate = {};
  const domains = split(d.domains);
  const senders = split(d.senders);
  const subjectPatterns = split(d.subjects);
  const listIds = split(d.lists);
  if (domains.length) predicate.domains = domains;
  if (senders.length) predicate.senders = senders;
  if (subjectPatterns.length) predicate.subjectPatterns = subjectPatterns;
  if (listIds.length) predicate.listIds = listIds;
  const threshold = d.threshold.trim() === "" ? null : Number(d.threshold);
  return {
    name: d.name.trim() || "Group",
    sentence: d.sentence.trim(),
    predicate,
    threshold:
      threshold !== null && Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : null,
    briefPolicy: d.briefPolicy === "default" ? null : d.briefPolicy,
  };
}

export function Routing({
  routing = defaultRouting,
  inbox = defaultInbox,
  workspaceId = workspace.id,
  onNavigate,
  api: apiOverride,
}: RoutingProps) {
  const shell = useShell();
  const { settings } = shell;
  const api = apiOverride ?? shell.api.routing;
  const s = useMemo(() => routingStrings(settings), [settings]);
  const groups = useSyncExternalStore(routing.subscribe, routing.groups, routing.groups);
  const decisions = useSyncExternalStore(routing.subscribe, routing.decisions, routing.decisions);
  const threads = useSyncExternalStore(inbox.subscribe, inbox.threads, inbox.threads);

  /** The Server's view: Examples, counts and Confidence. Null until it answers, or when it cannot. */
  const [views, setViews] = useState<Map<string, GroupView> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{ moves: ProposedMove[]; considered: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<Set<string>>(() => new Set());

  const refreshViews = useCallback(() => {
    api
      .groups(workspaceId)
      .then((list) => setViews(new Map(list.map((g) => [g.id, g]))))
      .catch(() => setViews(null));
  }, [api, workspaceId]);
  useEffect(() => {
    refreshViews();
  }, [refreshViews]);

  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const top = groups.filter((g) => g.parentId === null);
  const childrenOf = (id: string) => groups.filter((g) => g.parentId === id);
  const nameOfGroup = (id: string) => byId.get(id)?.name ?? id;
  const deepestName = (t: { group: string | null; subgroup: string | null }) =>
    t.subgroup ? nameOfGroup(t.subgroup) : t.group ? nameOfGroup(t.group) : null;

  const unreadIn = (id: string) =>
    threads.filter((t) => t.unread && (t.group === id || t.subgroup === id)).length;
  const confidenceOf = (id: string): number | null =>
    views?.get(id)?.confidence ?? (views === null ? (groupConfidence[id] ?? null) : null);

  const recent = threads.filter((t) => t.group !== null).slice(0, 8);
  const pending = decisions.filter((d) => !settled.has(d.threadId));

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const startEdit = (id: string) => {
    const g = byId.get(id);
    if (!g) return;
    setEditing(id);
    setDraft(draftOf(views?.get(id) ?? g));
  };

  const save = async () => {
    if (!editing || !draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateGroup(editing, inputOf(draft));
      setEditing(null);
      setDraft(null);
      refreshViews();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteGroup(editing);
      setEditing(null);
      setDraft(null);
      refreshViews();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const newGroup = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGroup(workspaceId, { name: s.new_group ?? "New group" });
      refreshViews();
      setEditing(created.id);
      setDraft(draftOf(created));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const rerun = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.rerun(workspaceId);
      setPreview({ moves: p.moves, considered: p.considered });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const applyPreview = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await api.apply(workspaceId, preview.moves);
      setPreview(null);
      refreshViews();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (threadId: string, groupId: string | null) => {
    setError(null);
    setSettled((prev) => new Set([...prev, threadId]));
    try {
      await api.decide(threadId, groupId);
      refreshViews();
    } catch (e) {
      // The row comes back: the Server did not take the choice.
      setSettled((prev) => new Set([...prev].filter((id) => id !== threadId)));
      fail(e);
    }
  };

  const targetOf = (m: ProposedMove) =>
    m.proposed.kind === "route"
      ? nameOfGroup(m.proposed.subgroupId ?? m.proposed.groupId)
      : m.proposed.kind === "ask"
        ? (s["preview.ask"] ?? "Needs a decision")
        : (s["preview.out"] ?? "No group");

  const editor =
    editing && draft ? (
      <div className="rule-edit">
        <label>
          <span>Name</span>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Rule</span>
          <textarea
            className="input"
            rows={3}
            value={draft.sentence}
            onChange={(e) => setDraft({ ...draft, sentence: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Always from these domains</span>
          <input
            className="input"
            value={draft.domains}
            onChange={(e) => setDraft({ ...draft, domains: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Always from these senders</span>
          <input
            className="input"
            value={draft.senders}
            onChange={(e) => setDraft({ ...draft, senders: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Always with these subjects</span>
          <input
            className="input"
            value={draft.subjects}
            onChange={(e) => setDraft({ ...draft, subjects: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Always from these lists</span>
          <input
            className="input"
            value={draft.lists}
            onChange={(e) => setDraft({ ...draft, lists: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>Route threshold, empty for the Setting</span>
          <input
            className="input"
            value={draft.threshold}
            onChange={(e) => setDraft({ ...draft, threshold: e.currentTarget.value })}
          />
        </label>
        <div className="rule-edit-row">
          <span>Brief policy</span>
          <Seg
            options={[
              { value: "default", label: "Setting" },
              { value: "always", label: "Always" },
              { value: "on_open", label: "On open" },
              { value: "never", label: "Never" },
            ]}
            value={draft.briefPolicy}
            onChange={(value) => setDraft({ ...draft, briefPolicy: value })}
          />
        </div>
        {views?.get(editing)?.examples.length ? (
          <div className="rule-examples">
            <span>
              {fill(s.examples ?? "{n} examples", { n: views.get(editing)?.examples.length ?? 0 })}
            </span>
            {views.get(editing)?.examples.map((e) => (
              <SampleRow
                key={`${e.threadId}:${e.positive}`}
                name={nameOf(e.from)}
                subject={e.subject}
                tag={e.positive ? "Belongs" : "Does not belong"}
              />
            ))}
          </div>
        ) : null}
        <div className="acts">
          <Btn sm primary onClick={save} disabled={busy}>
            Save
          </Btn>
          <Btn
            sm
            onClick={() => {
              setEditing(null);
              setDraft(null);
            }}
            disabled={busy}
          >
            Cancel
          </Btn>
          <Btn sm onClick={remove} disabled={busy}>
            Delete group
          </Btn>
        </div>
      </div>
    ) : null;

  return (
    <div className="main page">
      <div className="page-wrap">
        <div className="page-in">
          <PageHead title={s.title ?? "Routing"} subtitle={s.subtitle}>
            <Btn outline onClick={rerun} disabled={busy}>
              <ArrowsClockwiseIcon /> {s.rerun ?? "Re-run on inbox"}
            </Btn>
            <Btn primary onClick={newGroup} disabled={busy}>
              <PlusIcon /> {s.new_group ?? "New group"}
            </Btn>
          </PageHead>
          {error ? <p className="faint routing-error">{error}</p> : null}
          <div className="two">
            <div className="tree">
              {top.length === 0 ? (
                <div className="empty page-empty">
                  <p>{s.empty}</p>
                </div>
              ) : null}
              {top.map((g) => {
                const confidence = confidenceOf(g.id);
                const view = views?.get(g.id);
                const unread = view ? view.unread : unreadIn(g.id);
                const subgroups: SubgroupItem[] = childrenOf(g.id).map((c) => ({
                  id: c.id,
                  name: c.name,
                  description: c.rule.sentence.length > 0 ? c.rule.sentence : undefined,
                  count: views?.get(c.id)?.unread ?? unreadIn(c.id),
                  icon: groupIcon(c),
                }));
                return (
                  <div key={g.id}>
                    <GroupCard
                      id={g.id}
                      name={g.name}
                      meta={fill(s.unread ?? "{n} unread", { n: unread })}
                      confidence={
                        confidence === null
                          ? undefined
                          : fill(s.confident ?? "{n}% confident", {
                              n: Math.round(confidence * 100),
                            })
                      }
                      sentence={view?.rule.sentence ?? g.rule.sentence}
                      predicate={view?.rule.predicate ?? g.rule.predicate}
                      noRule={s.no_rule}
                      subgroups={subgroups}
                      changeRuleLabel={s.change_rule ?? "Change rule"}
                      onChangeRule={startEdit}
                      onMore={startEdit}
                      onOpenSubgroup={(id) => onNavigate?.(`group:${id}`)}
                    />
                    {editing === g.id || childrenOf(g.id).some((c) => c.id === editing)
                      ? editor
                      : null}
                  </div>
                );
              })}
            </div>
            <aside>
              {preview ? (
                <PreviewCard
                  title={s["preview.title"] ?? "What would move"}
                  summary={fill(s["preview.considered"] ?? "{moves} of {n} threads would move", {
                    moves: preview.moves.length,
                    n: preview.considered,
                  })}
                  moves={preview.moves.map((m) => ({
                    threadId: m.threadId,
                    name: nameOf(m.from),
                    subject: m.subject,
                    target: targetOf(m),
                  }))}
                  emptyLabel={s["preview.none"] ?? "Nothing would move"}
                  applyLabel={s["preview.apply"] ?? "Apply"}
                  cancelLabel={s["preview.cancel"] ?? "Cancel"}
                  onApply={applyPreview}
                  onCancel={() => setPreview(null)}
                  busy={busy}
                />
              ) : null}
              <SideCard title={s["ask.title"] ?? "Ask for a group"}>
                <AskBox
                  placeholder={s["ask.placeholder"] ?? ""}
                  help={s["ask.help"]}
                  onSubmit={() => onNavigate?.("agent")}
                />
              </SideCard>
              <SideCard title={s.decisions ?? "Needs a decision"} count={pending.length}>
                {pending.length === 0 ? (
                  <p className="faint" style={{ fontSize: "var(--fs-xs)", margin: 0 }}>
                    {s["decisions.empty"]}
                  </p>
                ) : null}
                {pending.map((d) => {
                  const t = inbox.thread(d.threadId);
                  const from = t?.participants[0] ?? d.participants[0] ?? null;
                  return (
                    <DecisionRow
                      key={d.threadId}
                      threadId={d.threadId}
                      name={nameOf(from)}
                      subject={t?.subject || d.subject}
                      candidates={d.candidates.map((c) => ({
                        id: c.groupId,
                        label: nameOfGroup(c.groupId),
                      }))}
                      onPick={(threadId, groupId) => void decide(threadId, groupId)}
                      onLeave={(threadId) => void decide(threadId, null)}
                      leaveLabel={s.leave ?? "Leave"}
                    />
                  );
                })}
              </SideCard>
              <SideCard title={s.recent ?? "Recently routed"}>
                {recent.map((t) => (
                  <SampleRow
                    key={t.id}
                    name={nameOf(t.participants[0] ?? null)}
                    subject={t.subject}
                    tag={deepestName(t) ?? undefined}
                  />
                ))}
              </SideCard>
            </aside>
          </div>
        </div>
      </div>
      {shell.layout.agent === "bottom" ? (
        <AgentDock>
          <AgentBar
            placeholder={settings["strings.agent.placeholder"]}
            onFocus={() => onNavigate?.("agent")}
          />
        </AgentDock>
      ) : null}
    </div>
  );
}
