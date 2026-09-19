// The panels on the Settings screens that are not Settings themselves
// (docs/spec/settings.md): the Voice profile, the CalDAV link, the Config
// file live view with its warnings and "Fix with monday", the Groups tree,
// the Meter with its month picker, the Activity log, the Server mode and
// upgrade cards, the Devices with pairing, Storage with the recovery file,
// External access and About. Each registers under a group name of its
// section with the terms the settings search finds it by, and the renderer
// places it above that group's controls. The Accounts panel lives in
// Accounts.tsx. Every failure a panel meets is shown in plain words; nothing
// is swallowed.

import {
  type ActivityRecord,
  type Device,
  type ExternalConsent,
  type ExternalCredential,
  type ExternalKeyCreated,
  type ExternalScope,
  formatMicros,
  type GroupView,
  type MeterMonth,
  type VoiceProfile,
} from "@monday/shared";
import { Btn, formatWhen, Input, Note, Seg, Switch, Tag } from "@monday/ui";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { AccountView, PendingPairings, StorageInfo } from "../../platform/api.ts";
import { platform } from "../../platform/tauri.ts";
import { useShell } from "../../shell/Shell.tsx";
import "./Accounts.tsx";
import {
  Card,
  DangerAction,
  messageOf,
  type PanelProps,
  registerPanel,
  useSettingsScreen,
} from "./render.tsx";
import { Server } from "./Server.tsx";
import { fill } from "./wizard.ts";

type Strings = ReturnType<typeof useShell>["settings"];

function failed(s: Strings, e: unknown): string {
  return fill(s["strings.settings.failed"], { message: messageOf(e) });
}

/* ------------------------------ Accounts: CalDAV and the Voice profile ------------------------------ */

/**
 * The CalDAV calendar link (slice 18): for each Account without a calendar
 * API, a form that links a CalDAV calendar (URL, user, app password) through
 * PUT /accounts/:id/caldav, which proves the link before storing it under the
 * credential envelope; a linked Account shows that and can unlink.
 */
export function CalDavPanel(_: PanelProps) {
  const shell = useShell();
  const s = shell.settings;
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [linked, setLinked] = useState<Record<string, string | true>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    shell.api.accounts
      .list()
      .then((r) => setAccounts(r.accounts.filter((a) => !a.capabilities.calendar)))
      .catch(() => setAccounts([]));
  }, [shell.api]);
  useEffect(() => {
    for (const a of accounts) {
      shell.api.calendar
        .info(a.workspaceId)
        .then((info) => {
          if (info.source === "caldav") setLinked((l) => ({ ...l, [a.id]: true }));
        })
        .catch(() => {});
    }
  }, [accounts, shell.api]);
  const submit = async (account: AccountView, form: HTMLFormElement) => {
    const data = new FormData(form);
    const link = {
      url: String(data.get("url") ?? "").trim(),
      user: String(data.get("user") ?? "").trim(),
      password: String(data.get("password") ?? ""),
    };
    if (!link.url || !link.user || !link.password) return;
    setBusy(account.id);
    setError(null);
    try {
      await shell.api.calendar.linkCalDav(account.id, link);
      setLinked((l) => ({ ...l, [account.id]: link.url }));
      form.reset();
    } catch (err) {
      setError(fill(s["strings.settings.caldav.failed"], { message: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  };
  const unlink = async (account: AccountView) => {
    setBusy(account.id);
    setError(null);
    try {
      await shell.api.calendar.linkCalDav(account.id, null);
      setLinked((l) => {
        const { [account.id]: _gone, ...rest } = l;
        return rest;
      });
    } catch (err) {
      setError(fill(s["strings.settings.caldav.failed"], { message: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title={s["strings.settings.caldav.title"]}
      hint={s["strings.settings.caldav.soon"]}
      block
      attrs={{ "data-panel": "caldav" }}
      foot={error ? <span className="err">{error}</span> : undefined}
    >
      {accounts.length > 0 ? (
        <div className="caldav">
          {accounts.map((a) => {
            const link = linked[a.id];
            return (
              <div key={a.id} className="caldav-account" data-account={a.id}>
                <div className="caldav-address">{a.address}</div>
                {link ? (
                  <div className="caldav-linked">
                    <span>
                      {link === true
                        ? s["strings.settings.caldav.linked_line"]
                        : fill(s["strings.settings.caldav.linked"], { url: link })}
                    </span>
                    <Btn sm disabled={busy === a.id} onClick={() => void unlink(a)}>
                      {s["strings.settings.caldav.unlink"]}
                    </Btn>
                  </div>
                ) : (
                  <form
                    className="caldav-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit(a, e.currentTarget);
                    }}
                  >
                    <Input
                      name="url"
                      type="url"
                      placeholder={s["strings.settings.caldav.url"]}
                      required
                    />
                    <Input name="user" placeholder={s["strings.settings.caldav.user"]} required />
                    <Input
                      name="password"
                      type="password"
                      placeholder={s["strings.settings.caldav.password"]}
                      required
                    />
                    <Btn sm type="submit" disabled={busy === a.id}>
                      {s["strings.settings.caldav.link"]}
                    </Btn>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}
registerPanel("accounts", "Meetings", CalDavPanel, {
  title: "strings.settings.caldav.title",
  description: "strings.settings.caldav.soon",
  searchTerms: ["caldav", "calendar", "icloud", "nextcloud", "fastmail", "link", "app password"],
});

/** The Voice profile: on or off, view and edit the description, rebuild from sent mail by asking. */
export function VoicePanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [profile, setProfile] = useState<VoiceProfile | null | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    shell.api.voice
      .get(screen.workspaceId)
      .then(setProfile)
      .catch(() => setProfile(null));
  }, [shell.api, screen.workspaceId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const put = (patch: Partial<Pick<VoiceProfile, "description" | "excerpts" | "enabled">>) => {
    setError(null);
    return shell.api.voice
      .put(screen.workspaceId, patch)
      .then(setProfile)
      .catch((e) => setError(failed(s, e)));
  };
  const built = profile?.builtAt
    ? `${fill(s["strings.settings.voice.built"], { when: formatWhen(profile.builtAt, screen.now()) })} · ${fill(s["strings.settings.voice.excerpts"], { n: profile.excerpts.length })}`
    : s["strings.settings.voice.never"];
  if (profile === null) {
    return (
      <Card
        title={s["strings.settings.voice.enabled"]}
        hint={s["strings.settings.voice.unavailable"]}
        attrs={{ "data-panel": "voice" }}
      />
    );
  }
  return (
    <Card
      title={s["strings.settings.voice.enabled"]}
      hint={s["strings.settings.voice.intro"]}
      attrs={{ "data-panel": "voice" }}
      foot={
        <>
          <span>{built}</span>
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          {editing === null ? (
            <>
              <button
                type="button"
                className="link"
                onClick={() => setEditing(profile?.description ?? "")}
              >
                {s["strings.settings.voice.edit"]}
              </button>
              {s["ai.level"] !== "off" ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => screen.onAsk(s["strings.settings.voice.rebuild_prompt"])}
                >
                  {s["strings.settings.voice.rebuild"]}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      }
    >
      <Switch
        on={profile?.enabled ?? false}
        disabled={profile === undefined}
        onChange={(on) => void put({ enabled: on })}
      />
      {editing !== null ? (
        <div className="voice-edit">
          <textarea
            className="input area"
            rows={6}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
          />
          <span className="wizard-action">
            <Btn
              sm
              primary
              onClick={() => {
                void put({ description: editing });
                setEditing(null);
              }}
            >
              {s["strings.settings.voice.save"]}
            </Btn>
            <Btn sm onClick={() => setEditing(null)}>
              {s["strings.settings.voice.cancel"]}
            </Btn>
          </span>
        </div>
      ) : profile?.description ? (
        <div className="code voice-text">{profile.description}</div>
      ) : null}
    </Card>
  );
}
registerPanel("accounts", "Voice profile", VoicePanel, {
  title: "strings.settings.voice.title",
  description: "strings.settings.voice.intro",
  searchTerms: ["voice", "tone", "style", "sent mail", "rebuild", "match my voice", "drafts"],
});

/* ------------------------------ Appearance: the Config file ------------------------------ */

/** The live view of monday.toml with the watcher state, warnings with line numbers, and "Fix with monday". */
export function ConfigPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const problems = [
    ...(shell.config.error
      ? [{ line: shell.config.error.line ?? 0, message: shell.config.error.message }]
      : []),
    ...shell.config.warnings.map((w) => ({ line: w.line, message: w.message })),
  ];
  const path = shell.config.file?.path ?? "...";
  return (
    <Card
      title={s["strings.settings.config.title"]}
      hint={s["strings.settings.config.intro"]}
      block
      attrs={{ "data-panel": "config" }}
      foot={
        <>
          <span className="code-head">
            <span className="live" />
            {s["strings.settings.config.watching"]} <span className="path">{path}</span>
          </span>
          <span className="sp" />
          {problems.length > 0 && s["ai.level"] !== "off" ? (
            <Btn
              sm
              primary
              onClick={() =>
                screen.onAsk(
                  fill(s["strings.settings.config.fix_prompt"], {
                    problems: problems.map((p) => `line ${p.line}: ${p.message}`).join("; "),
                  }),
                )
              }
            >
              {s["strings.settings.fix"]}
            </Btn>
          ) : null}
        </>
      }
    >
      {shell.config.error ? (
        <Note kind="error" attrs={{ "data-config-error": "" }}>
          {fill(s["strings.settings.config.error"], {
            line: shell.config.error.line ?? "?",
            message: shell.config.error.message,
          })}
        </Note>
      ) : null}
      {shell.config.warnings.map((w) => (
        <Note
          kind="warn"
          key={`${w.line}-${w.key}`}
          attrs={{ "data-config-warning": String(w.line ?? "") }}
        >
          {fill(s["strings.settings.config.warning"], { line: w.line ?? "?", message: w.message })}
        </Note>
      ))}
      <div className="code">
        {shell.config.file?.exists ? shell.config.file.text : s["strings.settings.config.none"]}
      </div>
    </Card>
  );
}
registerPanel("appearance", "Config file", ConfigPanel, {
  title: "strings.settings.config.title",
  description: "strings.settings.config.intro",
  searchTerms: ["monday.toml", "toml", "config", "dotfiles", "rice", "pinned", "warnings"],
});

/* ------------------------------ Routing: the Groups tree ------------------------------ */

/** Every Group with its sentence, threshold, Sub-groups and Example count, read-only. */
export function GroupsPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [groups, setGroups] = useState<GroupView[]>([]);
  useEffect(() => {
    let live = true;
    shell.api.routing
      .groups(screen.workspaceId)
      .then((g) => {
        if (live) setGroups(g);
      })
      .catch(() => {
        if (live) setGroups([]);
      });
    return () => {
      live = false;
    };
  }, [shell.api, screen.workspaceId]);
  const roots = groups.filter((g) => g.parentId === null);
  const line = (g: GroupView) =>
    fill(s["strings.settings.groups.line"], {
      threads: g.threads,
      examples: g.examples.length,
      threshold: Math.round((g.threshold ?? s["routing.threshold.route"]) * 100),
    });
  const row = (g: GroupView, sub: boolean) => (
    <div className={`group-row ${sub ? "sub" : ""}`} key={g.id} data-group-id={g.id}>
      <div>
        <b>{g.name}</b>
        <span>{g.rule.sentence || s["strings.routing.no_rule"]}</span>
      </div>
      <span className="count">{line(g)}</span>
    </div>
  );
  return (
    <Card
      title={s["strings.settings.groups.title"]}
      hint={s["strings.settings.groups.intro"]}
      block
      attrs={{ "data-panel": "groups" }}
    >
      <div className="groups-tree">
        {groups.length === 0 ? (
          <div className="note">{s["strings.settings.groups.empty"]}</div>
        ) : null}
        {roots.map((g) => [
          row(g, false),
          ...groups.filter((x) => x.parentId === g.id).map((x) => row(x, true)),
        ])}
      </div>
    </Card>
  );
}
registerPanel("routing", "Groups", GroupsPanel, {
  title: "strings.settings.groups.title",
  description: "strings.settings.groups.intro",
  searchTerms: ["groups", "smart inbox", "rule", "sentence", "examples", "sub-groups"],
});

/* ------------------------------ AI: the Meter and the Activity log ------------------------------ */

/** "2026-09" shifted by n months. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "2026-09" as the month a human reads. */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A month by Task and provider, with cost estimates; no budgets. Previous months a click away. */
export function MeterPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const thisMonth = screen.now().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [meter, setMeter] = useState<MeterMonth | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    shell.api.meter
      .month(screen.workspaceId, month)
      .then((m) => {
        if (live) setMeter(m);
      })
      .catch((e) => {
        if (live) {
          setMeter(null);
          setError(failed(s, e));
        }
      });
    return () => {
      live = false;
    };
  }, [shell.api, screen.workspaceId, month, s]);
  return (
    <Card
      title={monthLabel(month)}
      hint={s["strings.settings.meter.intro"]}
      block
      attrs={{ "data-panel": "meter", "data-month": month }}
      foot={
        <>
          <Btn
            sm
            icon
            aria-label={s["strings.settings.meter.previous"]}
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
          >
            <CaretLeftIcon />
          </Btn>
          <Btn
            sm
            icon
            aria-label={s["strings.settings.meter.next"]}
            disabled={month >= thisMonth}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          >
            <CaretRightIcon />
          </Btn>
          {month !== thisMonth ? (
            <button type="button" className="link" onClick={() => setMonth(thisMonth)}>
              {s["strings.settings.meter.this_month"]}
            </button>
          ) : null}
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          {meter ? (
            <span>{fill(s["strings.meter.total"], { cost: formatMicros(meter.costMicros) })}</span>
          ) : null}
        </>
      }
    >
      {!meter || meter.lines.length === 0 ? (
        <div className="note">{s["strings.meter.empty"]}</div>
      ) : (
        <div className="matrix meter-table">
          <div className="mr h">
            <div>{s["strings.settings.meter.task"]}</div>
            <div>{s["strings.settings.meter.provider"]}</div>
            <div>{s["strings.settings.meter.calls"]}</div>
            <div>{s["strings.settings.meter.tokens"]}</div>
            <div>{s["strings.settings.meter.cost"]}</div>
          </div>
          {meter.lines.map((l) => (
            <div className="mr" key={`${l.task}-${l.provider}`}>
              <div>{l.task}</div>
              <div>{l.provider}</div>
              <div>{l.calls}</div>
              <div>{(l.inputTokens + l.outputTokens).toLocaleString()}</div>
              <div>{formatMicros(l.costMicros)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
registerPanel("ai", "Meter", MeterPanel, {
  title: "strings.settings.meter.title",
  description: "strings.settings.meter.intro",
  searchTerms: ["meter", "usage", "cost", "tokens", "spend", "month", "billing", "calls"],
});

/** Searchable list of tool calls: tool, input summary, who approved, result, Undo where still possible. */
export function ActivityPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [rows, setRows] = useState<ActivityRecord[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    shell.api.agent
      .activity(screen.workspaceId)
      .then((r) => setRows(r.activity))
      .catch(() => setRows([]));
  }, [shell.api, screen.workspaceId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) =>
        [r.tool, r.inputSummary, r.result ?? ""].join(" ").toLowerCase().includes(needle),
      )
    : rows;
  const who = (r: ActivityRecord) =>
    r.status === "waiting"
      ? s["strings.settings.activity.waiting"]
      : r.decision === "approved"
        ? r.approvedBy === "standing"
          ? s["strings.settings.activity.standing"]
          : s["strings.settings.activity.approved"]
        : r.decision === "declined"
          ? s["strings.settings.activity.declined"]
          : s["strings.settings.activity.auto"];
  const undo = (r: ActivityRecord) => {
    setError(null);
    shell.api.agent
      .undo(r.id, r.sessionId)
      .then(refresh)
      .catch((e) =>
        setError(fill(s["strings.settings.activity.undo_failed"], { message: messageOf(e) })),
      );
  };
  return (
    <Card
      title={s["strings.settings.activity.title"]}
      hint={s["strings.settings.activity.intro"]}
      block
      attrs={{ "data-panel": "activity" }}
      foot={
        <>
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          <button type="button" className="link" onClick={refresh}>
            {s["strings.settings.activity.refresh"]}
          </button>
        </>
      }
    >
      <div className="activity">
        <div className="set-ask-row">
          <Input
            value={q}
            placeholder={s["strings.settings.activity.search"]}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {shown.length === 0 ? (
          <div className="note">{s["strings.settings.activity.empty"]}</div>
        ) : null}
        {shown.map((r) => (
          <div className="activity-row" key={r.id} data-activity={r.id}>
            <div>
              <b>
                <code>{r.tool}</code> {r.inputSummary}
              </b>
              <span>
                {formatWhen(r.at, screen.now())} · {who(r)}
                {r.result ? ` · ${r.result}` : ""}
              </span>
            </div>
            {r.undoneAt ? (
              <Tag>{s["strings.agent.undone"]}</Tag>
            ) : r.undoable && r.status === "done" ? (
              <Btn sm onClick={() => undo(r)}>
                {s["strings.agent.undo"]}
              </Btn>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
registerPanel("ai", "Activity log", ActivityPanel, {
  title: "strings.settings.activity.title",
  description: "strings.settings.activity.intro",
  searchTerms: ["activity", "log", "tool calls", "approved", "undo", "history", "audit"],
});

/* ------------------------------ Sync server ------------------------------ */

/** The Server's mode with health. */
export function ServerPanel(_: PanelProps) {
  const screen = useSettingsScreen();
  return <Server {...(screen.serverProps ?? {})} part="server" />;
}
registerPanel("server", "Server", ServerPanel, {
  title: "strings.server.talking_to",
  description: "strings.settings.intro.server",
  searchTerms: ["server", "sidecar", "cloud", "health", "mode", "endpoint", "latency"],
});

/** The three upgrade cards while Sidecar only, the database move and the Cloud connection (slice 21). */
export function CloudPanel(_: PanelProps) {
  const screen = useSettingsScreen();
  return <Server {...(screen.serverProps ?? {})} part="cloud" />;
}
registerPanel("server", "Cloud", CloudPanel, {
  title: "strings.server.upgrade.title",
  description: "strings.settings.intro.server.cloud",
  searchTerms: ["cloud", "vercel", "netlify", "container", "docker", "deploy", "upgrade", "pair"],
});

/** The paired Devices with last seen, this Device marked, revoke with confirm, and pairing. */
export function DevicesPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PendingPairings | null>(null);
  const [code, setCode] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    shell.api.devices
      .list()
      .then(setDevices)
      .catch(() => setDevices(null));
    shell.api.devices
      .me()
      .then((m) => setMe(m.id))
      .catch(() => setMe(null));
    shell.api.devices
      .pending()
      .then(setPairing)
      .catch(() => setPairing(null));
  }, [shell.api]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const approve = (c: string) => {
    setError(null);
    setBusy(true);
    shell.api.devices
      .confirm(c)
      .then(() => {
        setApproved(true);
        setCode("");
        refresh();
      })
      .catch((e) => setError(failed(s, e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="stack" data-panel="devices">
        {devices && devices.length === 0 ? (
          <div className="note">{s["strings.server.devices.empty"]}</div>
        ) : null}
        {(devices ?? []).map((d) => (
          <Card
            key={d.id}
            title={
              <span className="with-mark">
                <span className="lg">{d.name.slice(0, 1).toUpperCase()}</span>
                {d.name}
              </span>
            }
            hint={fill(s["strings.server.devices.last_seen"], {
              when: formatWhen(d.lastSeen, screen.now()),
            })}
            danger={d.id !== me}
            attrs={{ "data-device": d.id }}
            foot={
              d.id === me ? undefined : (
                <>
                  <span>{s["strings.server.devices.revoke_help"]}</span>
                  <span className="sp" />
                  <DangerAction
                    label={s["strings.server.devices.revoke"]}
                    confirm={fill(s["strings.server.devices.revoke_confirm"], { name: d.name })}
                    onConfirm={async () => {
                      await shell.api.devices.revoke(d.id);
                      refresh();
                    }}
                  />
                </>
              )
            }
          >
            {d.id === me ? <Tag kind="ok">{s["strings.settings.devices.this"]}</Tag> : null}
          </Card>
        ))}
      </div>
      <Card
        title={s["strings.settings.devices.pair"]}
        hint={s["strings.settings.devices.pair_help"]}
        block
        attrs={{ "data-panel": "pairing" }}
        foot={
          <>
            <span>{s["strings.server.devices.approve_help"]}</span>
            {error ? <span className="err">{error}</span> : null}
          </>
        }
      >
        {pairing?.setupAvailable ? (
          <div className="note">{s["strings.settings.devices.setup"]}</div>
        ) : null}
        {pairing && pairing.pending.length > 0 ? (
          <div className="accounts-list">
            {pairing.pending.map((p) => (
              <div className="account-row" key={p.code} data-pending={p.code}>
                <div className="lg">{p.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <b>
                    {fill(s["strings.settings.devices.pending_line"], {
                      name: p.name,
                      code: p.code,
                    })}
                  </b>
                  <span>{s["strings.settings.devices.pending"]}</span>
                </div>
                <span />
                <Btn sm primary disabled={busy} onClick={() => approve(p.code)}>
                  {s["strings.server.devices.approve"]}
                </Btn>
              </div>
            ))}
          </div>
        ) : null}
        <div className="wizard-action">
          <Input
            id="pair-code"
            aria-label={s["strings.server.devices.approve"]}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setApproved(false);
            }}
            inputMode="numeric"
            placeholder="000000"
            className="code-input"
          />
          <Btn disabled={busy || !/^\d{6}$/.test(code.trim())} onClick={() => approve(code.trim())}>
            {approved ? s["strings.server.devices.approved"] : s["strings.server.devices.approve"]}
          </Btn>
        </div>
      </Card>
    </>
  );
}
registerPanel("server", "Devices", DevicesPanel, {
  title: "strings.server.devices.title",
  description: "strings.server.devices.intro",
  searchTerms: ["devices", "pair", "pairing", "revoke", "code", "laptop", "phone", "approve"],
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * Message count and size, and the recovery file with export and import.
 * Export tries a download, and always shows the text with Copy, because a
 * webview may not save files.
 */
export function StoragePanel(_: PanelProps) {
  const shell = useShell();
  const s = shell.settings;
  const [storage, setStorage] = useState<StorageInfo | null | undefined>(undefined);
  const [recovery, setRecovery] = useState<string | null | undefined>(undefined);
  const [exported, setExported] = useState(false);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [imported, setImported] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    shell.api
      .storage()
      .then((st) => {
        if (live) setStorage(st);
      })
      .catch(() => {
        if (live) setStorage(null);
      });
    void platform().then((p) =>
      p
        .recoveryFile()
        .then((text) => {
          if (live) setRecovery(text);
        })
        .catch(() => {
          if (live) setRecovery(null);
        }),
    );
    return () => {
      live = false;
    };
  }, [shell.api]);

  const download = () => {
    if (!recovery) return;
    setExported(true);
    setCopied(false);
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
    try {
      const url = URL.createObjectURL(new Blob([recovery], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "monday-recovery-key.txt";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // A webview without downloads: the text below is the export.
    }
  };
  const copy = () => {
    if (!recovery) return;
    void navigator.clipboard?.writeText(recovery).catch(() => {});
    setCopied(true);
  };
  const doImport = () => {
    setImported(null);
    void platform().then((p) =>
      p
        .importRecoveryKey(importText)
        .then(() => {
          setImported({ ok: true, text: s["strings.settings.recovery.imported"] });
          setImporting(false);
          setImportText("");
        })
        .catch((e) => setImported({ ok: false, text: failed(s, e) })),
    );
  };

  return (
    <>
      <Card
        title={s["strings.settings.storage.label"]}
        hint={s["strings.settings.storage.help"]}
        attrs={{ "data-panel": "storage" }}
      >
        <span className="stat">
          {storage
            ? fill(s["strings.settings.storage.line"], {
                n: storage.messages.toLocaleString(),
                size: formatBytes(storage.bytes),
              })
            : s["strings.settings.storage.unknown"]}
        </span>
      </Card>
      <Card
        title={s["strings.settings.recovery.title"]}
        hint={s["strings.settings.recovery.help"]}
        block={exported || importing}
        attrs={{ "data-panel": "recovery" }}
        foot={
          <>
            <Tag kind={recovery ? "ok" : recovery === null ? "warn" : undefined}>
              {recovery === null
                ? s["strings.settings.recovery.missing"]
                : s["strings.settings.recovery.ok"]}
            </Tag>
            {imported ? <span className={imported.ok ? "ok" : "err"}>{imported.text}</span> : null}
            <span className="sp" />
            <span>{s["strings.settings.storage.export_help"]}</span>
          </>
        }
      >
        <span className="key-row">
          <Btn sm disabled={!recovery} onClick={download}>
            {s["strings.settings.recovery.export"]}
          </Btn>
          <Btn sm on={importing} onClick={() => setImporting((v) => !v)}>
            {s["strings.settings.recovery.import"]}
          </Btn>
        </span>
        {exported && recovery ? (
          <div className="voice-edit" data-panel="recovery-export">
            <span className="note">{s["strings.settings.storage.export_fallback"]}</span>
            <textarea className="input area mono" rows={3} readOnly value={recovery} />
            <span className="wizard-action">
              <Btn sm onClick={copy}>
                {copied
                  ? s["strings.settings.recovery.copied"]
                  : s["strings.settings.recovery.copy"]}
              </Btn>
              <Btn sm onClick={() => setExported(false)}>
                {s["strings.external.done"]}
              </Btn>
            </span>
          </div>
        ) : null}
        {importing ? (
          <div className="voice-edit" data-panel="recovery-import">
            <textarea
              className="input area mono"
              rows={3}
              value={importText}
              placeholder={s["strings.settings.recovery.import_placeholder"]}
              spellCheck={false}
              onChange={(e) => setImportText(e.target.value)}
            />
            <span className="wizard-action">
              <Btn sm primary disabled={!importText.trim()} onClick={doImport}>
                {s["strings.settings.recovery.import"]}
              </Btn>
            </span>
          </div>
        ) : null}
      </Card>
    </>
  );
}
registerPanel("server", "Storage", StoragePanel, {
  title: "strings.settings.storage.label",
  description: "strings.settings.recovery.help",
  searchTerms: ["storage", "messages", "size", "recovery", "key", "export", "import", "backup"],
});

/* ------------------------------ About ------------------------------ */

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "none" }
  | { kind: "available"; version: string; url: string }
  | { kind: "failed"; message: string };

/** "v0.2.0" and "0.2.0" compare as versions; true when `a` is newer than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Version, license, source, check for updates, and the telemetry line saying there is none. */
export function AboutPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const source = s["strings.settings.about.source_url"];
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const open = (url: string) => void platform().then((p) => p.openExternal(url));
  const os =
    typeof navigator !== "undefined" && navigator.platform ? navigator.platform : "unknown";
  const check = async () => {
    setUpdate({ kind: "checking" });
    try {
      const latest = await (screen.latestRelease ?? fetchLatestRelease)(source);
      setUpdate(
        latest === null
          ? { kind: "none" }
          : isNewerVersion(latest.version, screen.version)
            ? { kind: "available", version: latest.version, url: latest.url }
            : { kind: "latest" },
      );
    } catch (e) {
      setUpdate({ kind: "failed", message: messageOf(e) });
    }
  };
  return (
    <>
      <Card
        title={s["strings.settings.about.version"]}
        hint={fill(s["strings.settings.about.version_line"], {
          version: screen.version,
          platform: os,
        })}
        attrs={{ "data-panel": "about" }}
        foot={
          update.kind === "idle" ? undefined : (
            <>
              <span
                className={update.kind === "failed" ? "err" : update.kind === "latest" ? "ok" : ""}
              >
                {update.kind === "checking"
                  ? s["strings.settings.about.checking"]
                  : update.kind === "latest"
                    ? s["strings.settings.about.latest"]
                    : update.kind === "none"
                      ? s["strings.settings.about.no_release"]
                      : update.kind === "available"
                        ? fill(s["strings.settings.about.update_available"], {
                            version: update.version,
                          })
                        : fill(s["strings.settings.about.update_failed"], {
                            message: update.message,
                          })}
              </span>
              <span className="sp" />
              {update.kind === "available" ? (
                <button type="button" className="link" onClick={() => open(update.url)}>
                  {s["strings.settings.about.release_notes"]}
                </button>
              ) : null}
            </>
          )
        }
      >
        <Btn sm disabled={update.kind === "checking"} onClick={() => void check()}>
          {s["strings.settings.about.updates"]}
        </Btn>
      </Card>
      <Card
        title={s["strings.settings.about.license"]}
        hint={s["strings.settings.about.license_name"]}
        attrs={{ "data-panel": "license" }}
      >
        <Btn sm onClick={() => open(source)}>
          {s["strings.settings.about.source"]}
        </Btn>
      </Card>
      <Card
        title={s["strings.settings.about.telemetry"]}
        hint={s["strings.about.telemetry"]}
        attrs={{ "data-panel": "telemetry" }}
      />
    </>
  );
}
registerPanel("about", "About", AboutPanel, {
  title: "strings.settings.about.version",
  description: "strings.settings.intro.about",
  searchTerms: ["about", "version", "update", "license", "source", "github", "telemetry", "mit"],
});

/** The newest release of the source repository from GitHub's releases API; null when none is published. */
export async function fetchLatestRelease(
  source: string,
): Promise<{ version: string; url: string } | null> {
  const m = /github\.com\/([^/]+)\/([^/]+)/.exec(source);
  if (!m) throw new Error("no release source");
  const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.json()) as { tag_name?: string; html_url?: string };
  if (!body.tag_name) return null;
  return { version: body.tag_name, url: body.html_url ?? `${source}/releases` };
}

/* ------------------------------ External access (docs/spec/external-mcp.md, slice 19) ------------------------------ */

/** The Workspaces line of a credential: all, or how many. */
function workspacesLine(c: Pick<ExternalCredential, "workspaceIds">, s: Strings): string {
  if (c.workspaceIds === null) return s["strings.external.workspaces.all"];
  return fill(s["strings.external.workspaces.some"], { n: c.workspaceIds.length });
}

/**
 * Keys and connected OAuth clients with kind, scope, Workspaces, expiry and
 * last use, each revocable; the New key form, whose key is shown once with
 * Copy; the OAuth consents waiting for approval, by list or by code.
 */
export function ExternalAccessPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [credentials, setCredentials] = useState<ExternalCredential[] | null>(null);
  const [consents, setConsents] = useState<ExternalConsent[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ExternalScope>("read");
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [days, setDays] = useState(String(s["external.key_expiry_days"]));
  const [made, setMade] = useState<ExternalKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [approvedCode, setApprovedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    shell.api.external
      .credentials()
      .then(setCredentials)
      .catch(() => setCredentials(null));
    shell.api.external
      .consents()
      .then(setConsents)
      .catch(() => setConsents([]));
    shell.api.accounts
      .list()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
  }, [shell.api]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = () => {
    setError(null);
    setBusy(true);
    const expiresInDays = Number(days);
    shell.api.external
      .createKey({
        name: name.trim(),
        scope,
        workspaceIds: chosen,
        ...(Number.isInteger(expiresInDays) && expiresInDays > 0 ? { expiresInDays } : {}),
      })
      .then((k) => {
        setMade(k);
        setCopied(false);
        setCreating(false);
        setName("");
        setChosen(null);
        refresh();
      })
      .catch((e) => setError(failed(s, e)))
      .finally(() => setBusy(false));
  };
  const copy = () => {
    if (!made) return;
    void navigator.clipboard?.writeText(made.secret).catch(() => {});
    setCopied(true);
  };
  // A consent is approved for every Workspace; narrowing is the key form's business.
  const approve = (ref: { id: string } | { code: string }) => {
    setConsentError(null);
    setBusy(true);
    shell.api.external
      .approveConsent(ref, null)
      .then(() => {
        if ("code" in ref) {
          setApprovedCode(true);
          setCode("");
        }
        refresh();
      })
      .catch((e: unknown) => {
        if ((e as { status?: number })?.status === 404)
          setConsentError(s["strings.external.consents.unknown"]);
        else setConsentError(failed(s, e));
      })
      .finally(() => setBusy(false));
  };
  const status = (c: ExternalCredential): { kind: "ok" | "warn"; label: string } => {
    if (c.revokedAt) return { kind: "warn", label: s["strings.external.revoked"] };
    if (Date.parse(c.expiresAt) <= screen.now().getTime()) {
      return { kind: "warn", label: s["strings.external.expired"] };
    }
    return {
      kind: "ok",
      label: fill(s["strings.external.expires"], { when: formatWhen(c.expiresAt, screen.now()) }),
    };
  };
  const scopeLabel = (scope: ExternalScope) =>
    scope === "read" ? s["strings.external.scope.read"] : s["strings.external.scope.act"];
  const toggleWorkspace = (id: string) =>
    setChosen((current) => {
      const all = accounts.map((a) => a.workspaceId);
      const set = new Set(current ?? all);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return set.size === all.length ? null : [...set];
    });

  return (
    <>
      {made ? (
        <Card
          title={made.credential.name}
          hint={`${scopeLabel(made.credential.scope)} · ${s["strings.external.shown_once"]}`}
          block
          attrs={{ "data-panel": "external-key" }}
        >
          <div className="wizard-action">
            <Input readOnly value={made.secret} data-secret className="grow" />
            <Btn primary onClick={copy}>
              {copied ? s["strings.external.copied"] : s["strings.external.copy"]}
            </Btn>
            <Btn onClick={() => setMade(null)}>{s["strings.external.done"]}</Btn>
          </div>
        </Card>
      ) : null}
      <div className="stack" data-panel="external">
        {credentials && credentials.length === 0 ? (
          <div className="note">{s["strings.external.empty"]}</div>
        ) : null}
        {(credentials ?? []).map((c) => {
          const st = status(c);
          return (
            <Card
              key={c.id}
              title={
                <span className="with-mark">
                  <span className="lg">{c.kind === "key" ? "K" : "O"}</span>
                  {c.name}
                  {c.prefix ? ` (${c.prefix}...)` : ""}
                </span>
              }
              hint={[
                c.kind === "key"
                  ? s["strings.external.kind.key"]
                  : s["strings.external.kind.oauth"],
                scopeLabel(c.scope),
                workspacesLine(c, s),
                c.lastUsedAt
                  ? fill(s["strings.external.last_used"], {
                      when: formatWhen(c.lastUsedAt, screen.now()),
                    })
                  : s["strings.external.never_used"],
              ].join(" · ")}
              danger={!c.revokedAt}
              attrs={{ "data-credential": c.id }}
              foot={
                c.revokedAt ? undefined : (
                  <>
                    <span>{s["strings.external.revoke_help"]}</span>
                    <span className="sp" />
                    <DangerAction
                      label={s["strings.external.revoke"]}
                      confirm={fill(s["strings.external.revoke_confirm"], { name: c.name })}
                      onConfirm={async () => {
                        await shell.api.external.revoke(c.id);
                        refresh();
                      }}
                    />
                  </>
                )
              }
            >
              <Tag kind={st.kind}>{st.label}</Tag>
            </Card>
          );
        })}
      </div>
      {creating ? (
        <Card
          title={s["strings.external.new_key"]}
          hint={s["strings.external.new_key_help"]}
          block
          attrs={{ "data-panel": "external-new" }}
          foot={
            <>
              {error ? <span className="err">{error}</span> : null}
              <span className="sp" />
              <Btn sm onClick={() => setCreating(false)}>
                {s["strings.external.form.cancel"]}
              </Btn>
              <Btn sm primary disabled={busy || !name.trim()} onClick={create}>
                {s["strings.external.form.create"]}
              </Btn>
            </>
          }
        >
          <div className="wizard-fields">
            <div className="wizard-field">
              <label className="wizard-label" htmlFor="external-name">
                {s["strings.external.form.name"]}
              </label>
              <Input
                id="external-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={s["strings.external.form.name_placeholder"]}
              />
            </div>
            <div className="wizard-field">
              <span className="wizard-label">{s["strings.external.form.scope"]}</span>
              <Seg
                options={[
                  { value: "read", label: s["strings.external.scope.read"] },
                  { value: "act", label: s["strings.external.scope.act"] },
                ]}
                value={scope}
                onChange={setScope}
              />
            </div>
            {accounts.length > 1 ? (
              <div className="wizard-field">
                <span className="wizard-label">{s["strings.external.form.workspaces"]}</span>
                {accounts.map((a) => (
                  <label key={a.workspaceId} className="check">
                    <input
                      type="checkbox"
                      checked={chosen === null || chosen.includes(a.workspaceId)}
                      onChange={() => toggleWorkspace(a.workspaceId)}
                    />{" "}
                    {a.address}
                  </label>
                ))}
              </div>
            ) : null}
            <div className="wizard-field">
              <label className="wizard-label" htmlFor="external-days">
                {s["strings.external.form.expiry"]}
              </label>
              <Input
                id="external-days"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="code-input"
              />
            </div>
          </div>
        </Card>
      ) : (
        <div className="stack-actions">
          <Btn outline onClick={() => setCreating(true)}>
            {s["strings.external.new_key"]}
          </Btn>
        </div>
      )}
      <Card
        title={s["strings.external.consents.title"]}
        hint={s["strings.external.consents.help"]}
        block
        attrs={{ "data-panel": "external-consents" }}
        foot={consentError ? <span className="err">{consentError}</span> : undefined}
      >
        {consents.length > 0 ? (
          <div className="accounts-list">
            {consents.map((c) => (
              <div className="account-row" key={c.id} data-consent={c.id}>
                <div className="lg">{c.clientName.slice(0, 1).toUpperCase()}</div>
                <div>
                  <b>
                    {fill(s["strings.external.consents.line"], {
                      client: c.clientName,
                      scope: scopeLabel(c.scope),
                      code: c.code,
                    })}
                  </b>
                  <span>{workspacesLine(c, s)}</span>
                </div>
                <Btn
                  sm
                  disabled={busy}
                  onClick={() => {
                    setConsentError(null);
                    shell.api.external
                      .denyConsent(c.id)
                      .then(refresh)
                      .catch((e) => setConsentError(failed(s, e)));
                  }}
                >
                  {s["strings.external.consents.deny"]}
                </Btn>
                <Btn sm primary disabled={busy} onClick={() => approve({ id: c.id })}>
                  {s["strings.external.consents.approve"]}
                </Btn>
              </div>
            ))}
          </div>
        ) : null}
        <div className="wizard-action">
          <Input
            id="external-code"
            aria-label={s["strings.external.consents.approve"]}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setApprovedCode(false);
            }}
            inputMode="numeric"
            placeholder="000000"
            className="code-input"
          />
          <Btn
            disabled={busy || !/^\d{6}$/.test(code.trim())}
            onClick={() => approve({ code: code.trim() })}
          >
            {approvedCode
              ? s["strings.external.consents.approved"]
              : s["strings.external.consents.approve"]}
          </Btn>
        </div>
      </Card>
    </>
  );
}
registerPanel("ai", "External access", ExternalAccessPanel, {
  title: "strings.external.title",
  description: "strings.settings.intro.ai.external-access",
  searchTerms: [
    "external",
    "mcp",
    "api key",
    "oauth",
    "consent",
    "claude desktop",
    "cursor",
    "revoke",
  ],
});
