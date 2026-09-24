// The Routing page (docs/spec/routing.md; design/js/screens/routing.js): an
// overview line (Groups, Sections, what waits for a decision, whether new
// mail is sorted), then three tabs. Groups: each Group as a card with its
// rule in plain words, what always goes there (the Predicate as chips), its
// threshold, Sub-groups, Confidence and what it learned from the user's
// corrections (Examples). Sections and judgments, and Custom actions: the
// Sections block and the Actions block (slice 26, OrganizeBlocks.tsx), which
// edit sections.rules, sections.order and actions.custom through the Shell,
// the same rows the Agent writes. Beside them: the Needs a decision queue
// with accept or leave, "Recently routed" with why each Thread went where it
// did, and the re-run with preview, which asks the Server for a dry run and
// applies only on the second click. While the AI level keeps sorting paused
// the page says so and offers to raise it; the Groups, rules, Sections and
// actions stay, editable by hand, and each rule says it is paused. Groups
// and decisions come from the Store (the feed keeps them current);
// Examples, Confidence, routes and the actions go through the API. Every
// string is a Setting (strings.routing.*).

import type {
  Group,
  GroupInput,
  GroupView,
  KeyProvider,
  Predicate,
  ProposedMove,
  Settings,
  ThreadRoute,
} from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AskBox,
  Btn,
  DecisionRow,
  Icon,
  type IconComponent,
  motionMs,
  PageHead,
  PreviewCard,
  personName,
  RoutedRow,
  RuleGroupCard,
  SampleRow,
  Seg,
  SideCard,
  type SubgroupItem,
  Tabs,
} from "@monday/ui";
import { groupIcon as fixtureGroupIcon } from "@monday/ui/fixtures";
import { ArrowsClockwiseIcon, PlusIcon } from "@phosphor-icons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Api } from "../platform/api.ts";
import { useShell } from "../shell/Shell.tsx";
import { useWorkspace } from "../workspace.tsx";
import { fixtureInbox, type InboxSource } from "./inbox/actions.ts";
import { fill } from "./inbox/triage.ts";
import { LevelLock, useLevelLock } from "./LevelLock.tsx";
import { ActionsBlock, SectionsBlock, sectionNameOf } from "./routing/OrganizeBlocks.tsx";
import { fixtureRouting, type RoutingSource } from "./routing/routing-data.ts";
import { predicateChips, whyRouted } from "./routing/why.ts";

export interface RoutingProps {
  /** Groups and Needs a decision; the Store's implementation in the app, fixtures in tests. */
  routing?: RoutingSource | undefined;
  /** The stream, for unread counts and "Recently routed". */
  inbox?: InboxSource | undefined;
  /** The Workspace shown; the current one by default. */
  workspaceId?: string | undefined;
  /** Opens a Group in the inbox. */
  onNavigate?: ((target: string) => void) | undefined;
  /** Hands "Ask for a group" to the composer with the sentence typed; without it the composer just opens. */
  onAsk?: ((text: string) => void) | undefined;
  /**
   * The bottom agent the App owns, so asking here opens it here without
   * leaving the page; absent, a bar that hands off to the Inbox's.
   */
  agent?: ReactNode | undefined;
  /** The Server side of the page; the Shell's client by default, a fake in tests. */
  api?: RoutingApi | undefined;
  /** Which Hosted providers hold a shared key; the Shell's client by default, null where no Server is. */
  keys?: Pick<Api["keys"], "shared"> | null | undefined;
  /** An icon per Group, when the nav has one; the mock's on the dev server, none in the app. */
  groupIcon?: ((g: Group) => IconComponent | undefined) | undefined;
}

export type RoutingApi = Api["routing"];

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
  p ? personName(p, "?") : "?";

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
  routing: routingProp,
  inbox: inboxProp,
  workspaceId: workspaceIdProp,
  onNavigate,
  onAsk,
  api: apiOverride,
  keys: keysProp,
  groupIcon: groupIconProp,
  agent,
}: RoutingProps) {
  const shell = useShell();
  const { settings } = shell;
  const current = useWorkspace();
  const workspaceId = workspaceIdProp ?? current.id;
  // Without the Store's seams (the App always passes them), the design fixtures stand in on the
  // browser dev server only, where no Server exists; with a Server the page starts empty.
  const server = shell.server !== null;
  const fallbackRouting = useMemo(
    () => (server ? fixtureRouting([], []) : fixtureRouting()),
    [server],
  );
  const fallbackInbox = useMemo(() => (server ? fixtureInbox([]) : fixtureInbox()), [server]);
  const routing = routingProp ?? fallbackRouting;
  const inbox = inboxProp ?? fallbackInbox;
  const groupIcon = groupIconProp ?? (server ? undefined : fixtureGroupIcon);
  const keys = keysProp === undefined ? (shell.server ? shell.api.keys : null) : keysProp;
  const api = apiOverride ?? shell.api.routing;
  const s = useMemo(() => routingStrings(settings), [settings]);
  // Just mail (CONTEXT.md "AI level"): the Groups stay, hand-made; nothing here asks the Agent.
  const aiOff = settings["ai.level"] === "off";
  // Below automate nothing is sorted unasked: the page says so and keeps everything, by hand.
  const { locked, levelName } = useLevelLock();
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
  /** Rows answered a moment ago, still on screen while they fade out. */
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  /** Delete asks once: the button names the Group until the second click. */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Whether a shared key exists for routing on the Server; null until known or where it cannot be. */
  const [sharedKeys, setSharedKeys] = useState<KeyProvider[] | null>(null);
  const [tab, setTab] = useState<"groups" | "sections" | "actions">("groups");
  /** Groups whose corrections (Examples) are open. */
  const [openLearned, setOpenLearned] = useState<Set<string>>(() => new Set());
  /** Where routing put the recent Threads and how, for "why"; empty until the Server answers. */
  const [routes, setRoutes] = useState<Map<string, ThreadRoute>>(() => new Map());

  const refreshViews = useCallback(() => {
    api
      .groups(workspaceId)
      .then((list) => setViews(new Map(list.map((g) => [g.id, g]))))
      .catch(() => setViews(null));
  }, [api, workspaceId]);
  useEffect(() => {
    refreshViews();
  }, [refreshViews]);
  useEffect(() => {
    if (!keys) return;
    let live = true;
    keys
      .shared()
      .then((r) => {
        if (live) setSharedKeys(r.shared);
      })
      .catch(() => {
        if (live) setSharedKeys(null);
      });
    return () => {
      live = false;
    };
  }, [keys]);
  const hostedNeeded = settings["ai.level"] === "automate" && sharedKeys?.length === 0;

  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const top = groups.filter((g) => g.parentId === null);
  const childrenOf = (id: string) => groups.filter((g) => g.parentId === id);
  const nameOfGroup = (id: string) => byId.get(id)?.name ?? id;
  const deepestName = (t: { group: string | null; subgroup: string | null }) =>
    t.subgroup ? nameOfGroup(t.subgroup) : t.group ? nameOfGroup(t.group) : null;

  const unreadIn = (id: string) =>
    threads.filter((t) => t.unread && (t.group === id || t.subgroup === id)).length;
  const confidenceOf = (id: string): number | null => views?.get(id)?.confidence ?? null;

  const recent = useMemo(
    () => threads.filter((t) => t.group !== null).slice(0, settings["routing.page.recent_shown"]),
    [threads, settings],
  );
  const recentKey = recent.map((t) => t.id).join(",");
  // Routes live on the Server: asked when there is one, or when a test hands the api in.
  const remote = server || apiOverride !== undefined;
  // The route record says how each recent Thread was placed; a Thread never routed has none.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recentKey stands for the recent ids.
  useEffect(() => {
    if (!remote || recent.length === 0) return;
    let live = true;
    Promise.all(recent.map((t) => api.routeOf(t.id).catch(() => null)))
      .then((list) => {
        if (!live) return;
        setRoutes(new Map(list.flatMap((r) => (r ? [[r.threadId, r] as const] : []))));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, remote, recentKey]);
  const sectionRules = settings["sections.rules"];
  const sectionOrder = settings["sections.order"];
  const sectionOptions = useMemo(
    () => sectionRules.map((r) => ({ id: r.id, name: sectionNameOf(settings, r) })),
    [sectionRules, settings],
  );
  const groupOptions = useMemo(() => groups.map((g) => ({ id: g.id, name: g.name })), [groups]);
  const changeSections = useCallback(
    async (rules: typeof sectionRules, order: typeof sectionOrder) => {
      const a = await shell.set("sections.rules", rules);
      if (!a.ok) {
        setError(a.message);
        return;
      }
      const b = await shell.set("sections.order", order);
      if (!b.ok) setError(b.message);
    },
    [shell],
  );
  const changeActions = useCallback(
    async (actions: (typeof settings)["actions.custom"]) => {
      const r = await shell.set("actions.custom", actions);
      if (!r.ok) setError(r.message);
    },
    [shell],
  );
  const pending = decisions.filter((d) => !settled.has(d.threadId));
  const stillShown = pending.filter((d) => !leaving.has(d.threadId));

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const startEdit = (id: string) => {
    const g = byId.get(id);
    if (!g) return;
    setEditing(id);
    setConfirmDelete(false);
    setDraft(draftOf(views?.get(id) ?? g));
  };
  const stopEdit = () => {
    setEditing(null);
    setDraft(null);
    setConfirmDelete(false);
  };

  const save = async () => {
    if (!editing || !draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateGroup(editing, inputOf(draft));
      stopEdit();
      refreshViews();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    // Deleting is not reversible: the first click only names what would go (ADR 0002).
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteGroup(editing);
      stopEdit();
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

  const without = (prev: Set<string>, threadId: string) =>
    new Set([...prev].filter((id) => id !== threadId));
  const decide = async (threadId: string, groupId: string | null) => {
    setError(null);
    // The row fades for one --t-med, then leaves; with transitions off it leaves at once.
    const ms = motionMs("--t-med");
    if (ms > 0) {
      setLeaving((prev) => new Set([...prev, threadId]));
      setTimeout(() => {
        setLeaving((prev) => without(prev, threadId));
        setSettled((prev) => new Set([...prev, threadId]));
      }, ms);
    } else {
      setSettled((prev) => new Set([...prev, threadId]));
    }
    try {
      await api.decide(threadId, groupId);
      refreshViews();
    } catch (e) {
      // The row comes back: the Server did not take the choice.
      setLeaving((prev) => without(prev, threadId));
      setSettled((prev) => without(prev, threadId));
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
          <span>{s["edit.name"]}</span>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>{s["edit.sentence"]}</span>
          <textarea
            className="input"
            rows={3}
            value={draft.sentence}
            onChange={(e) => setDraft({ ...draft, sentence: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>{s["edit.domains"]}</span>
          <input
            className="input"
            value={draft.domains}
            onChange={(e) => setDraft({ ...draft, domains: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>{s["edit.senders"]}</span>
          <input
            className="input"
            value={draft.senders}
            onChange={(e) => setDraft({ ...draft, senders: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>{s["edit.subjects"]}</span>
          <input
            className="input"
            value={draft.subjects}
            onChange={(e) => setDraft({ ...draft, subjects: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>{s["edit.lists"]}</span>
          <input
            className="input"
            value={draft.lists}
            onChange={(e) => setDraft({ ...draft, lists: e.currentTarget.value })}
          />
        </label>
        <label>
          <span>{s["edit.threshold"]}</span>
          <input
            className="input"
            value={draft.threshold}
            onChange={(e) => setDraft({ ...draft, threshold: e.currentTarget.value })}
          />
        </label>
        <div className="rule-edit-row">
          <span>{s["edit.brief_policy"]}</span>
          <Seg
            options={[
              { value: "default", label: s["edit.brief.default"] ?? "Setting" },
              { value: "always", label: s["edit.brief.always"] ?? "Always" },
              { value: "on_open", label: s["edit.brief.on_open"] ?? "On open" },
              { value: "never", label: s["edit.brief.never"] ?? "Never" },
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
                tag={e.positive ? s["edit.belongs"] : s["edit.not_belongs"]}
              />
            ))}
          </div>
        ) : null}
        <div className="acts">
          <Btn sm primary onClick={save} disabled={busy}>
            {s["edit.save"]}
          </Btn>
          <Btn sm onClick={stopEdit} disabled={busy}>
            {s["edit.cancel"]}
          </Btn>
          <Btn sm onClick={remove} disabled={busy} className={confirmDelete ? "danger" : undefined}>
            {confirmDelete
              ? fill(s["edit.delete_confirm"] ?? "Delete {name} for good", { name: draft.name })
              : s["edit.delete"]}
          </Btn>
        </div>
      </div>
    ) : null;

  const visibleSections = sectionRules.filter((r) => !r.hidden).length;
  const sortingKey = locked
    ? "stat.sorting_paused"
    : settings["routing.on_arrival"]
      ? "stat.sorting_on"
      : "stat.sorting_manual";

  const groupsTab = (
    <div className="rt-groups">
      {top.length === 0 ? (
        <div className="empty page-empty">
          <p>{s.empty}</p>
        </div>
      ) : null}
      {top.map((g) => {
        const confidence = confidenceOf(g.id);
        const view = views?.get(g.id);
        const unread = view ? view.unread : unreadIn(g.id);
        const rule = view?.rule ?? g.rule;
        const examples = view?.examples ?? [];
        const threshold = view?.threshold ?? g.threshold;
        const subgroups: SubgroupItem[] = childrenOf(g.id).map((c) => ({
          id: c.id,
          name: c.name,
          description: c.rule.sentence.length > 0 ? c.rule.sentence : undefined,
          count: views?.get(c.id)?.unread ?? unreadIn(c.id),
          icon: groupIcon?.(c),
        }));
        const open = openLearned.has(g.id);
        return (
          <RuleGroupCard
            key={g.id}
            id={g.id}
            name={g.name}
            icon={groupIcon?.(g)}
            stats={[
              fill(s.unread ?? "{n} unread", { n: unread }),
              ...(view ? [fill(s.threads ?? "{n} threads", { n: view.threads })] : []),
            ]}
            confidence={confidence}
            confidenceLabel={
              confidence === null
                ? undefined
                : fill(s.confident ?? "{n}% confident", { n: Math.round(confidence * 100) })
            }
            ruleLabel={s.rule_label ?? "Rule"}
            sentence={rule.sentence}
            predicate={rule.predicate}
            noRule={s.no_rule}
            alwaysLabel={s.always_label ?? "Always"}
            always={predicateChips(rule.predicate, settings)}
            threshold={
              threshold === null || threshold === undefined
                ? undefined
                : fill(s.threshold ?? "", { pct: Math.round(threshold * 100) })
            }
            pausedLabel={locked ? settings["strings.ai.lock.paused"] : undefined}
            subgroups={subgroups}
            learned={
              examples.length
                ? {
                    label:
                      examples.length === 1
                        ? (s.learned_one ?? "")
                        : fill(s.learned ?? "", { n: examples.length }),
                    toggle: open ? (s.learned_hide ?? "Hide") : (s.learned_show ?? "Show"),
                    open,
                    onToggle: () =>
                      setOpenLearned((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.id)) next.delete(g.id);
                        else next.add(g.id);
                        return next;
                      }),
                    body: examples.map((e) => (
                      <SampleRow
                        key={`${e.threadId}:${e.positive}`}
                        name={nameOf(e.from)}
                        subject={e.subject}
                        tag={e.positive ? s["edit.belongs"] : s["edit.not_belongs"]}
                      />
                    )),
                  }
                : undefined
            }
            changeRuleLabel={s.change_rule ?? "Change rule"}
            onChangeRule={startEdit}
            openLabel={s.open ?? "Open"}
            onOpen={onNavigate ? (id) => onNavigate(`group:${id}`) : undefined}
            onOpenSubgroup={(id) => onNavigate?.(`group:${id}`)}
          >
            {editing === g.id || childrenOf(g.id).some((c) => c.id === editing) ? editor : null}
          </RuleGroupCard>
        );
      })}
    </div>
  );

  return (
    <div className="main page">
      <div className="page-wrap">
        <div className="page-in rt-page">
          <PageHead title={s.title ?? "Routing"} subtitle={s.subtitle}>
            {locked ? null : (
              <Btn outline onClick={rerun} disabled={busy}>
                <Icon icon={ArrowsClockwiseIcon} /> {s.rerun ?? "Re-run on inbox"}
              </Btn>
            )}
            <Btn primary={!locked} outline={locked} onClick={newGroup} disabled={busy}>
              <Icon icon={PlusIcon} /> {s.new_group ?? "New group"}
            </Btn>
          </PageHead>
          {error ? (
            <p className="faint routing-error" role="alert">
              {error}
            </p>
          ) : null}
          {hostedNeeded && !locked ? <p className="faint routing-note">{s.hosted_needed}</p> : null}
          {locked ? (
            <LevelLock
              title={s["locked.title"] ?? ""}
              lede={s["locked.lede"] ?? ""}
              body={fill(top.length ? (s["locked.body"] ?? "") : (s["locked.body_empty"] ?? ""), {
                level: levelName,
                n: top.length,
              })}
              benefits={settings["strings.routing.locked.benefits"]}
              onNavigate={onNavigate}
            />
          ) : null}
          <div
            className="rt-stats"
            data-sorting={locked ? "paused" : settings["routing.on_arrival"] ? "on" : "manual"}
          >
            <span>{fill(s["stat.groups"] ?? "{n} Groups", { n: top.length })}</span>
            <span>{fill(s["stat.sections"] ?? "{n} Sections", { n: visibleSections })}</span>
            <span>{fill(s["stat.decisions"] ?? "{n} to decide", { n: stillShown.length })}</span>
            <span className="rt-sorting">
              <span className="rt-sorting-dot" aria-hidden="true" />
              {s[sortingKey]}
            </span>
          </div>
          <div className="two rt-two">
            <div className="tree">
              <Tabs
                className="rt-tabs"
                items={[
                  { key: "groups", label: s["tab.groups"] ?? "Groups", count: top.length },
                  {
                    key: "sections",
                    label: s["tab.sections"] ?? "Sections",
                    count: visibleSections,
                  },
                  {
                    key: "actions",
                    label: s["tab.actions"] ?? "Custom actions",
                    count: settings["actions.custom"].length,
                  },
                ]}
                active={tab}
                onChange={setTab}
              />
              {tab === "groups" ? groupsTab : null}
              {tab === "sections" ? (
                <SectionsBlock
                  settings={settings}
                  rules={sectionRules}
                  order={sectionOrder}
                  onChange={changeSections}
                  onRenameString={(key, name) =>
                    shell.set(key as Parameters<typeof shell.set>[0], name as never)
                  }
                  onAsk={locked ? undefined : onAsk}
                />
              ) : null}
              {tab === "actions" ? (
                <ActionsBlock
                  settings={settings}
                  actions={settings["actions.custom"]}
                  onChange={changeActions}
                  groups={groupOptions}
                  sections={sectionOptions}
                  onAsk={locked ? undefined : onAsk}
                />
              ) : null}
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
              {aiOff || locked ? null : (
                <SideCard title={s["ask.title"] ?? "Ask for a group"}>
                  <AskBox
                    placeholder={s["ask.placeholder"] ?? ""}
                    help={s["ask.help"]}
                    onSubmit={(text) => {
                      const sentence = text.trim();
                      if (sentence && onAsk) {
                        onAsk(fill(s["ask.prefix"] ?? "Make a group: {sentence}", { sentence }));
                      } else onNavigate?.("agent");
                    }}
                  />
                </SideCard>
              )}
              <SideCard
                title={s.decisions ?? "Needs a decision"}
                count={stillShown.length}
                className="rt-decisions"
              >
                {pending.length === 0 ? (
                  <p className="faint rt-empty-line">{s["decisions.empty"]}</p>
                ) : null}
                {pending.map((d) => {
                  const t = inbox.thread(d.threadId);
                  const from = t?.participants[0] ?? d.participants[0] ?? null;
                  return (
                    <DecisionRow
                      key={d.threadId}
                      className={leaving.has(d.threadId) ? "leaving" : undefined}
                      threadId={d.threadId}
                      name={nameOf(from)}
                      subject={t?.subject || d.subject}
                      candidates={d.candidates.map((c) => ({
                        id: c.groupId,
                        label: fill(s.candidate ?? "{name} {pct}%", {
                          name: nameOfGroup(c.groupId),
                          pct: Math.round(c.confidence * 100),
                        }),
                      }))}
                      onPick={(threadId, groupId) => void decide(threadId, groupId)}
                      onLeave={(threadId) => void decide(threadId, null)}
                      leaveLabel={s.leave ?? "Leave"}
                    />
                  );
                })}
              </SideCard>
              {settings["routing.page.recent_shown"] > 0 ? (
                <SideCard title={s.recent ?? "Recently routed"} className="rt-recent">
                  {recent.length === 0 ? (
                    <p className="faint rt-empty-line">{s.recent_empty}</p>
                  ) : null}
                  {recent.map((t) => (
                    <RoutedRow
                      key={t.id}
                      name={nameOf(t.participants[0] ?? null)}
                      subject={t.subject}
                      target={deepestName(t) ?? ""}
                      why={whyRouted(t, byId, routes.get(t.id) ?? null, settings)}
                    />
                  ))}
                </SideCard>
              ) : null}
            </aside>
          </div>
        </div>
      </div>
      {shell.layout.agent === "bottom" && !aiOff
        ? (agent ?? (
            <AgentDock>
              <AgentBar
                placeholder={settings["strings.agent.placeholder"]}
                onFocus={() => onNavigate?.("agent")}
              />
            </AgentDock>
          ))
        : null}
    </div>
  );
}
