// The panels on the Settings screens that are not Settings themselves
// (docs/spec/settings.md): the Accounts list with add and remove, the Voice
// profile, the CalDAV placeholder, the Config file live view with its warnings
// and "Fix with monday", the Groups tree, the Meter, the Activity log, the
// Server mode and upgrade cards, the Devices with pairing, Storage with the
// recovery file, and About. Each registers under a group name of its section,
// and the renderer places it above that group's controls.

import {
  type ActivityRecord,
  type Device,
  formatMicros,
  type GroupView,
  type MeterMonth,
  type VoiceProfile,
} from "@monday/shared";
import { Btn, formatWhen, Input, Tag } from "@monday/ui";
import { useCallback, useEffect, useState } from "react";
import type { AccountView, PendingPairings, StorageInfo } from "../../platform/api.ts";
import { platform } from "../../platform/tauri.ts";
import { useShell } from "../../shell/Shell.tsx";
import { AddAccount } from "./AddAccount.tsx";
import { type PanelProps, registerPanel, useSettingsScreen } from "./render.tsx";
import { Server } from "./Server.tsx";
import { fill } from "./wizard.ts";

/* ------------------------------ Accounts ------------------------------ */

const PROVIDER_LOGO: Record<string, string> = { gmail: "G", graph: "M", jmap: "J", imap: "@" };

/** The connected Accounts: provider, sync state, native or emulated actions, remove, add. */
export function AccountsPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [adding, setAdding] = useState(false);
  const refresh = useCallback(() => {
    shell.api.accounts
      .list()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
  }, [shell.api]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (adding) {
    return (
      <AddAccount
        onCancel={() => setAdding(false)}
        onAdded={() => {
          refresh();
        }}
      />
    );
  }
  const native = (a: AccountView) => a.capabilities.push || a.provider === "gmail";
  return (
    <div className="accounts-list" data-panel="accounts">
      {accounts.length === 0 ? <div className="note">{s["strings.accounts.empty"]}</div> : null}
      {accounts.map((a) => (
        <div className="account-row" key={a.id}>
          <div className="lg">{PROVIDER_LOGO[a.provider] ?? "@"}</div>
          <div>
            <b>{a.address}</b>
            <span>
              {a.lastError ??
                [
                  a.provider,
                  a.capabilities.push ? s["strings.accounts.push"] : s["strings.accounts.polling"],
                  native(a)
                    ? s["strings.settings.accounts.native"]
                    : s["strings.settings.accounts.emulated"],
                  a.lastSync
                    ? fill(s["strings.settings.accounts.last_sync"], {
                        when: formatWhen(a.lastSync, screen.now()),
                      })
                    : s["strings.settings.accounts.never"],
                ].join(" · ")}
            </span>
          </div>
          <Tag kind={a.connected && !a.lastError ? "ok" : "warn"}>
            {a.lastError
              ? s["strings.server.health.down"]
              : a.connected
                ? s["strings.accounts.push"]
                : s["strings.accounts.syncing"]}
          </Tag>
          <Btn
            sm
            onClick={() => {
              if (!confirm(fill(s["strings.accounts.remove_confirm"], { address: a.address })))
                return;
              shell.api.accounts
                .remove(a.id)
                .then(refresh)
                .catch(() => {});
            }}
          >
            {s["strings.accounts.remove"]}
          </Btn>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <Btn outline onClick={() => setAdding(true)}>
          {s["strings.accounts.add"]}
        </Btn>
      </div>
    </div>
  );
}
registerPanel("accounts", "Accounts", AccountsPanel);

/** The CalDAV calendar link: a placeholder until the calendar slice. */
export function CalDavPanel(_: PanelProps) {
  const s = useShell().settings;
  return (
    <div className="field" data-panel="caldav">
      <div className="l">
        <b>{s["strings.settings.caldav.title"]}</b>
        <span>{s["strings.settings.caldav.soon"]}</span>
      </div>
    </div>
  );
}
registerPanel("accounts", "Meetings", CalDavPanel);

/** The Voice profile: on or off, view and edit the description, rebuild from sent mail by asking. */
export function VoicePanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [profile, setProfile] = useState<VoiceProfile | null | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = useCallback(() => {
    shell.api.voice
      .get(screen.workspaceId)
      .then(setProfile)
      .catch(() => setProfile(null));
  }, [shell.api, screen.workspaceId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const put = (patch: Partial<Pick<VoiceProfile, "description" | "excerpts" | "enabled">>) =>
    shell.api.voice
      .put(screen.workspaceId, patch)
      .then(setProfile)
      .catch(() => {});
  return (
    <div className="voice" data-panel="voice">
      <p>{s["strings.settings.voice.intro"]}</p>
      {profile === null ? (
        <div className="note">{s["strings.settings.voice.unavailable"]}</div>
      ) : (
        <>
          <div className="field">
            <div className="l">
              <b>{s["strings.settings.voice.enabled"]}</b>
              <span>
                {profile?.builtAt
                  ? `${fill(s["strings.settings.voice.built"], { when: formatWhen(profile.builtAt, screen.now()) })} · ${fill(s["strings.settings.voice.excerpts"], { n: profile.excerpts.length })}`
                  : s["strings.settings.voice.never"]}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={profile?.enabled ?? false}
              className={`switch ${profile?.enabled ? "on" : ""}`}
              disabled={profile === undefined}
              onClick={() => void put({ enabled: !(profile?.enabled ?? false) })}
            />
          </div>
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
          ) : (
            <>
              {profile?.description ? <div className="code">{profile.description}</div> : null}
              <span className="wizard-action">
                <Btn sm onClick={() => setEditing(profile?.description ?? "")}>
                  {s["strings.settings.voice.edit"]}
                </Btn>
                <Btn sm onClick={() => screen.onAsk(s["strings.settings.voice.rebuild_prompt"])}>
                  {s["strings.settings.voice.rebuild"]}
                </Btn>
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}
registerPanel("accounts", "Voice profile", VoicePanel);

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
  return (
    <div data-panel="config">
      <p>{s["strings.settings.config.intro"]}</p>
      {shell.config.error ? (
        <div className="note warn">
          {fill(s["strings.settings.config.error"], {
            line: shell.config.error.line ?? "?",
            message: shell.config.error.message,
          })}
        </div>
      ) : null}
      {shell.config.warnings.map((w) => (
        <div className="note warn" key={`${w.line}-${w.key}`}>
          {fill(s["strings.settings.config.warning"], { line: w.line ?? "?", message: w.message })}
        </div>
      ))}
      {problems.length > 0 ? (
        <div className="wizard-action" style={{ marginBottom: 12 }}>
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
        </div>
      ) : null}
      <div className="code-head">
        <span className="live" />
        {s["strings.settings.config.watching"]}{" "}
        <span style={{ color: "var(--fg)" }}>{shell.config.file?.path ?? "…"}</span>
      </div>
      <div className="code">
        {shell.config.file?.exists ? shell.config.file.text : s["strings.settings.config.none"]}
      </div>
    </div>
  );
}
registerPanel("appearance", "Config file", ConfigPanel);

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
    <div className="groups-tree" data-panel="groups">
      <p>{s["strings.settings.groups.intro"]}</p>
      {groups.length === 0 ? (
        <div className="note">{s["strings.settings.groups.empty"]}</div>
      ) : null}
      {roots.map((g) => [
        row(g, false),
        ...groups.filter((x) => x.parentId === g.id).map((x) => row(x, true)),
      ])}
    </div>
  );
}
registerPanel("routing", "Groups", GroupsPanel);

/* ------------------------------ AI: the Meter and the Activity log ------------------------------ */

/** This month by Task and provider, with cost estimates; no budgets. */
export function MeterPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [meter, setMeter] = useState<MeterMonth | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    shell.api.meter
      .month(screen.workspaceId)
      .then((m) => {
        if (live) setMeter(m);
      })
      .catch(() => {
        if (live) setMeter(null);
      });
    return () => {
      live = false;
    };
  }, [shell.api, screen.workspaceId]);
  return (
    <div className="meter" data-panel="meter">
      <p>{s["strings.settings.meter.intro"]}</p>
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
          <div className="mr total">
            <div>{fill(s["strings.meter.total"], { cost: formatMicros(meter.costMicros) })}</div>
          </div>
        </div>
      )}
    </div>
  );
}
registerPanel("ai", "Meter", MeterPanel);

/** Searchable list of tool calls: tool, input summary, who approved, result, Undo where still possible. */
export function ActivityPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [rows, setRows] = useState<ActivityRecord[]>([]);
  const [q, setQ] = useState("");
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
  return (
    <div className="activity" data-panel="activity">
      <p>{s["strings.settings.activity.intro"]}</p>
      <div className="ask-row">
        <Input
          value={q}
          placeholder={s["strings.settings.activity.search"]}
          onChange={(e) => setQ(e.target.value)}
        />
        <Btn sm onClick={refresh}>
          {s["strings.settings.activity.refresh"]}
        </Btn>
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
            <Btn
              sm
              onClick={() => {
                shell.api.agent
                  .undo(r.id, r.sessionId)
                  .then(refresh)
                  .catch(() => {});
              }}
            >
              {s["strings.agent.undo"]}
            </Btn>
          ) : null}
        </div>
      ))}
    </div>
  );
}
registerPanel("ai", "Activity log", ActivityPanel);

/* ------------------------------ Sync server ------------------------------ */

/** The Server's mode with health. */
export function ServerPanel(_: PanelProps) {
  const screen = useSettingsScreen();
  return <Server {...(screen.serverProps ?? {})} part="server" />;
}
registerPanel("server", "Server", ServerPanel);

/** The three upgrade cards while Sidecar only, the database move and the Cloud connection (slice 21). */
export function CloudPanel(_: PanelProps) {
  const screen = useSettingsScreen();
  return <Server {...(screen.serverProps ?? {})} part="cloud" />;
}
registerPanel("server", "Cloud", CloudPanel);

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
    shell.api.devices
      .confirm(c)
      .then(() => {
        setApproved(true);
        setCode("");
        refresh();
      })
      .catch((e) =>
        setError(fill(s["strings.server.error.generic"], { message: String(e?.message ?? e) })),
      );
  };

  return (
    <div data-panel="devices">
      <p>{s["strings.server.devices.intro"]}</p>
      <div className="accounts-list">
        {devices && devices.length === 0 ? (
          <div className="note">{s["strings.server.devices.empty"]}</div>
        ) : null}
        {(devices ?? []).map((d) => (
          <div className="account-row" key={d.id} data-device={d.id}>
            <div className="lg">{d.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <b>{d.name}</b>
              <span>
                {fill(s["strings.server.devices.last_seen"], {
                  when: formatWhen(d.lastSeen, screen.now()),
                })}
              </span>
            </div>
            {d.id === me ? <Tag kind="ok">{s["strings.settings.devices.this"]}</Tag> : <span />}
            <Btn
              sm
              onClick={() => {
                if (!confirm(fill(s["strings.server.devices.revoke_confirm"], { name: d.name })))
                  return;
                shell.api.devices
                  .revoke(d.id)
                  .then(refresh)
                  .catch(() => {});
              }}
            >
              {s["strings.server.devices.revoke"]}
            </Btn>
          </div>
        ))}
      </div>
      <div className="sect pair" data-panel="pairing">
        <h3>{s["strings.settings.devices.pair"]}</h3>
        <p>{s["strings.settings.devices.pair_help"]}</p>
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
                <Btn sm primary onClick={() => approve(p.code)}>
                  {s["strings.server.devices.approve"]}
                </Btn>
              </div>
            ))}
          </div>
        ) : null}
        <div className="wizard-fields">
          <div className="wizard-field">
            <label className="wizard-label" htmlFor="pair-code">
              {s["strings.server.devices.approve"]}
            </label>
            <div className="wizard-action">
              <Input
                id="pair-code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setApproved(false);
                }}
                inputMode="numeric"
                placeholder="000000"
                style={{ width: 120 }}
              />
              <Btn disabled={!/^\d{6}$/.test(code.trim())} onClick={() => approve(code.trim())}>
                {approved
                  ? s["strings.server.devices.approved"]
                  : s["strings.server.devices.approve"]}
              </Btn>
            </div>
            <span className="help">{s["strings.server.devices.approve_help"]}</span>
          </div>
          {error ? <div className="wizard-check bad">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
registerPanel("server", "Devices", DevicesPanel);

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

/** Message count and size, and the recovery file with export and import. */
export function StoragePanel(_: PanelProps) {
  const shell = useShell();
  const s = shell.settings;
  const [storage, setStorage] = useState<StorageInfo | null | undefined>(undefined);
  const [recovery, setRecovery] = useState<string | null | undefined>(undefined);
  const [exported, setExported] = useState(false);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [imported, setImported] = useState<string | null>(null);

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
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([recovery], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "monday-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = () => {
    if (!recovery) return;
    void navigator.clipboard?.writeText(recovery).catch(() => {});
    setCopied(true);
  };
  const doImport = () => {
    void platform().then((p) =>
      p
        .importRecoveryKey(importText)
        .then(() => {
          setImported(s["strings.settings.recovery.imported"]);
          setImporting(false);
          setImportText("");
        })
        .catch((e) =>
          setImported(
            fill(s["strings.server.error.generic"], { message: String(e?.message ?? e) }),
          ),
        ),
    );
  };

  return (
    <div data-panel="storage">
      <div className="field">
        <div className="l">
          <b>{s["strings.settings.storage.label"]}</b>
          <span>
            {storage
              ? fill(s["strings.settings.storage.line"], {
                  n: storage.messages.toLocaleString(),
                  size: formatBytes(storage.bytes),
                })
              : s["strings.settings.storage.unknown"]}
          </span>
        </div>
      </div>
      <div className="field">
        <div className="l">
          <b>{s["strings.settings.recovery.title"]}</b>
          <span>{s["strings.settings.recovery.help"]}</span>
          {imported ? <span className="ok">{imported}</span> : null}
        </div>
        <span className="key-row">
          <Tag kind={recovery ? "ok" : recovery === null ? "warn" : undefined}>
            {recovery === null
              ? s["strings.settings.recovery.missing"]
              : s["strings.settings.recovery.ok"]}
          </Tag>
          <Btn sm disabled={!recovery} onClick={download}>
            {s["strings.settings.recovery.export"]}
          </Btn>
          {exported ? (
            <Btn sm onClick={copy}>
              {copied ? s["strings.settings.recovery.copied"] : s["strings.settings.recovery.copy"]}
            </Btn>
          ) : null}
          <Btn sm onClick={() => setImporting((v) => !v)}>
            {s["strings.settings.recovery.import"]}
          </Btn>
        </span>
      </div>
      {importing ? (
        <div className="voice-edit">
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
    </div>
  );
}
registerPanel("server", "Storage", StoragePanel);

/* ------------------------------ About ------------------------------ */

/** Version, license, source, check for updates, and the telemetry line saying there is none. */
export function AboutPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const source = s["strings.settings.about.source_url"];
  const open = (url: string) => void platform().then((p) => p.openExternal(url));
  const os =
    typeof navigator !== "undefined" && navigator.platform ? navigator.platform : "unknown";
  return (
    <div data-panel="about">
      <div className="field">
        <div className="l">
          <b>{s["strings.settings.about.version"]}</b>
          <span>
            {fill(s["strings.settings.about.version_line"], {
              version: screen.version,
              platform: os,
            })}
          </span>
        </div>
        <Btn sm onClick={() => open(`${source}/releases`)}>
          {s["strings.settings.about.updates"]}
        </Btn>
      </div>
      <div className="field">
        <div className="l">
          <b>{s["strings.settings.about.license"]}</b>
          <span>{s["strings.settings.about.license_name"]}</span>
        </div>
        <Btn sm onClick={() => open(source)}>
          {s["strings.settings.about.source"]}
        </Btn>
      </div>
      <div className="field">
        <div className="l">
          <b>{s["strings.settings.about.telemetry"]}</b>
          <span>{s["strings.about.telemetry"]}</span>
        </div>
      </div>
    </div>
  );
}
registerPanel("about", "About", AboutPanel);
