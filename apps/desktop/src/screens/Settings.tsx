// Settings › Accounts and Appearance over the Shell. Every control comes from the
// settings schema; a Pinned key renders locked with "set in monday.toml" (ADR 0001,
// docs/spec/settings.md). Accounts lists what is connected and hosts the add-account
// paths (slice 9); the remaining sections arrive in slice 17.

import { type Density, type SettingKey, settingsSchema, type ThemeMode } from "@monday/shared";
import { Btn, palettes, Seg, SettingsField, Swatch, Tag } from "@monday/ui";
import {
  AtIcon,
  GearSixIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AccountView } from "../platform/api.ts";
import { useShell } from "../shell/Shell.tsx";
import { AddAccount } from "./settings/AddAccount.tsx";
import { fill } from "./settings/wizard.ts";

const NAV: Array<{ key: string; label: string; icon: ReactNode }> = [
  { key: "accounts", label: "Accounts", icon: <AtIcon /> },
  { key: "appearance", label: "Appearance", icon: <PaletteIcon /> },
  { key: "about", label: "About", icon: <GearSixIcon /> },
];

export function Settings({ initialSection = "appearance" }: { initialSection?: string }) {
  const [section, setSection] = useState(initialSection);
  return (
    <div className="main page">
      <div className="settings">
        <nav className="settings-nav">
          <h4>Settings</h4>
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`nav-item ${section === n.key ? "on" : ""}`}
              onClick={() => setSection(n.key)}
            >
              {n.icon}
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-in">
            {section === "accounts" ? (
              <Accounts />
            ) : section === "appearance" ? (
              <Appearance />
            ) : (
              <About />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const PROVIDER_LOGO: Record<string, string> = { gmail: "G", graph: "M", jmap: "J", imap: "@" };

export function Accounts() {
  const shell = useShell();
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
  return (
    <>
      <h1>{s["strings.accounts.title"]}</h1>
      <p>{s["strings.accounts.intro"]}</p>
      <div className="accounts-list">
        {accounts.length === 0 ? <div className="note">{s["strings.accounts.empty"]}</div> : null}
        {accounts.map((a) => (
          <div className="account-row" key={a.id}>
            <div className="lg">{PROVIDER_LOGO[a.provider] ?? "@"}</div>
            <div>
              <b>{a.address}</b>
              <span>{a.lastError ?? a.provider}</span>
            </div>
            <Tag kind={a.capabilities.push ? "ok" : undefined}>
              {a.capabilities.push ? s["strings.accounts.push"] : s["strings.accounts.polling"]}
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
      </div>
      <Btn primary onClick={() => setAdding(true)}>
        {s["strings.accounts.add"]}
      </Btn>
    </>
  );
}

function Pinned({ k, children }: { k: SettingKey; children: ReactNode }) {
  const shell = useShell();
  if (!shell.pinned.has(k)) return <>{children}</>;
  return (
    <span
      title={`Set in ${shell.config.file?.path ?? "monday.toml"}`}
      style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}
    >
      <Tag>{shell.settings["strings.settings.pinned"]}</Tag>
      <span style={{ opacity: 0.5, pointerEvents: "none" }}>{children}</span>
    </span>
  );
}

function Appearance() {
  const shell = useShell();
  const s = shell.settings;
  const resolved: "light" | "dark" =
    s["appearance.mode"] === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : s["appearance.mode"];
  const help = (k: SettingKey) => settingsSchema[k].help;

  return (
    <>
      <h1>Appearance</h1>
      <p>
        The agent and this page save to your settings. A key set in your config file wins and shows
        here as pinned.
      </p>

      {shell.config.error ? (
        <div className="note" style={{ marginBottom: 16 }}>
          Config file line {shell.config.error.line ?? "?"}: {shell.config.error.message}. Using the
          last good config.
        </div>
      ) : null}
      {shell.config.warnings.map((w) => (
        <div className="note" key={`${w.line}-${w.key}`} style={{ marginBottom: 8 }}>
          Line {w.line}: {w.message}
        </div>
      ))}

      <div className="sect">
        <h3>Theme</h3>
        <SettingsField label="Mode" hint={help("appearance.mode")}>
          <Pinned k="appearance.mode">
            <Seg<ThemeMode>
              options={[
                { value: "system", label: "System", icon: MonitorIcon },
                { value: "light", label: "Light", icon: SunIcon },
                { value: "dark", label: "Dark", icon: MoonIcon },
              ]}
              value={s["appearance.mode"]}
              onChange={(v) => void shell.set("appearance.mode", v)}
            />
          </Pinned>
        </SettingsField>
      </div>

      <div className="sect">
        <h3>Palette</h3>
        <p>{help("appearance.palette")}</p>
        <Pinned k="appearance.palette">
          <div className="swatches">
            {palettes.map((p) => (
              <Swatch
                key={p.key}
                palette={p}
                mode={resolved}
                on={s["appearance.palette"] === p.key}
                onSelect={(k) => void shell.set("appearance.palette", k)}
              />
            ))}
          </div>
        </Pinned>
      </div>

      <div className="sect">
        <h3>Layout</h3>
        <SettingsField label="Navigation" hint={help("layout.nav")}>
          <Pinned k="layout.nav">
            <Seg
              options={[
                { value: "full", label: "Full" },
                { value: "rail", label: "Rail" },
                { value: "hidden", label: "Hidden" },
              ]}
              value={s["layout.nav"]}
              onChange={(v) => void shell.set("layout.nav", v)}
            />
          </Pinned>
        </SettingsField>
        <SettingsField label="Agent" hint={help("layout.agent")}>
          <Pinned k="layout.agent">
            <Seg
              options={[
                { value: "bottom", label: "Bottom bar" },
                { value: "left", label: "Left column" },
                { value: "right", label: "Right column" },
              ]}
              value={s["layout.agent"]}
              onChange={(v) => void shell.set("layout.agent", v)}
            />
          </Pinned>
        </SettingsField>
        <SettingsField label="List" hint={help("layout.list")}>
          <Pinned k="layout.list">
            <Seg
              options={[
                { value: "stream", label: "Stream" },
                { value: "split", label: "Split" },
              ]}
              value={s["layout.list"]}
              onChange={(v) => void shell.set("layout.list", v)}
            />
          </Pinned>
        </SettingsField>
        <SettingsField label="Density" hint={help("appearance.density")}>
          <Pinned k="appearance.density">
            <Seg<Density>
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
                { value: "spacious", label: "Spacious" },
              ]}
              value={s["appearance.density"]}
              onChange={(v) => void shell.set("appearance.density", v)}
            />
          </Pinned>
        </SettingsField>
      </div>

      <div className="sect">
        <h3>Config file</h3>
        <p>
          Yours, never written by the app unless you ask. Keys set here win over saved settings and
          show as pinned above.
        </p>
        <div className="code-head">
          <span className="live" />
          watching <span style={{ color: "var(--fg)" }}>{shell.config.file?.path ?? "…"}</span>
        </div>
        <div className="code">
          {shell.config.file?.exists ? shell.config.file.text : "# no config file yet"}
        </div>
      </div>
    </>
  );
}

function About() {
  const shell = useShell();
  return (
    <>
      <h1>About</h1>
      <p>monday is free, open source and self-hostable.</p>
      <div className="sect">
        <SettingsField
          label="Server"
          hint={shell.sidecar?.running ? `Sidecar on port ${shell.sidecar.port}` : "starting"}
        >
          <Btn>Check for updates</Btn>
        </SettingsField>
        <SettingsField label="Telemetry" hint={shell.settings["strings.about.telemetry"]} />
      </div>
    </>
  );
}
