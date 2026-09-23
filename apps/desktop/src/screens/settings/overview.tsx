// The overview card at the top of each Settings section (docs/spec/settings.md,
// "Disclosure"): the section's current state in plain words and the two or
// three things people come to the section to do. Every word is a strings
// Setting; every action is a navigation to a card or group (which opens the
// disclosures it sits in) or one Setting change with Undo from the toast. AI
// and agent at `off` shows the level cards and nothing else, so no overview.

import {
  type AiLevel,
  HOSTED_PROVIDERS,
  levelAtLeast,
  PROVIDER_LABELS,
  type SettingSection,
} from "@monday/shared";
import { Btn, palettes } from "@monday/ui";
import type { ReactNode } from "react";
import { useShell } from "../../shell/Shell.tsx";
import { useAccounts, useKeyState } from "./controls.tsx";
import { optionLabel, overviews, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

type Strings = ReturnType<typeof useShell>["settings"];

interface Action {
  label: string;
  run: () => void;
}

/** The card: the lines as one paragraph, the actions as small buttons. */
function OverviewCard({
  section,
  lines,
  actions,
}: {
  section: SettingSection;
  lines: ReadonlyArray<string | null | false>;
  actions: ReadonlyArray<Action | null | false>;
}) {
  const s = useShell().settings;
  const text = lines.filter((l): l is string => typeof l === "string" && l !== "");
  const buttons = actions.filter((a): a is Action => Boolean(a));
  return (
    <section
      className="soverview"
      data-overview={section}
      aria-label={s["strings.settings.overview.title"]}
    >
      <p>{text.join(" ")}</p>
      {buttons.length > 0 ? (
        <div className="soverview-actions">
          {buttons.map((a) => (
            <Btn sm key={a.label} onClick={a.run}>
              {a.label}
            </Btn>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function useGo() {
  const screen = useSettingsScreen();
  return (section: SettingSection, at?: string) => () => screen.navigate?.(section, at);
}

function AccountsOverview() {
  const s = useShell().settings;
  const go = useGo();
  const accounts = useAccounts();
  const problems = accounts.filter((a) => a.lastError).length;
  const first = accounts[0];
  return (
    <OverviewCard
      section="accounts"
      lines={[
        accounts.length === 0 || !first
          ? s["strings.settings.overview.accounts.none"]
          : accounts.length === 1
            ? fill(s["strings.settings.overview.accounts.one"], { address: first.address })
            : fill(s["strings.settings.overview.accounts.many"], { n: accounts.length }),
        problems > 0 && fill(s["strings.settings.overview.accounts.problems"], { n: problems }),
        accounts.length > 0 &&
          (s["send.signature"].trim()
            ? s["strings.settings.overview.accounts.signature"]
            : s["strings.settings.overview.accounts.no_signature"]),
      ]}
      actions={[
        {
          label: s["strings.settings.overview.accounts.connect"],
          run: go("accounts", "Your accounts"),
        },
        accounts.length > 0 && {
          label: s["strings.settings.overview.accounts.edit_signature"],
          run: go("accounts", "send.signature"),
        },
      ]}
    />
  );
}

function AppearanceOverview() {
  const shell = useShell();
  const s = shell.settings;
  const screen = useSettingsScreen();
  const go = useGo();
  const mode = s["appearance.mode"];
  const palette =
    palettes.find((p) => p.key === s["appearance.palette"])?.label ??
    s["strings.settings.palette.custom"];
  const problems = shell.config.warnings.length > 0 || shell.config.error !== null;
  const dark = mode === "dark";
  return (
    <OverviewCard
      section="appearance"
      lines={[
        fill(s["strings.settings.overview.appearance.line"], {
          mode: s[`strings.settings.overview.appearance.${mode}`],
          palette,
          layout: optionLabel(s["layout.preset"]).toLowerCase(),
          density: optionLabel(s["appearance.density"]).toLowerCase(),
        }),
        problems && s["strings.settings.overview.appearance.problems"],
      ]}
      actions={[
        {
          label: dark
            ? s["strings.settings.overview.appearance.use_light"]
            : s["strings.settings.overview.appearance.use_dark"],
          run: () => void screen.change("appearance.mode", dark ? "light" : "dark"),
        },
        {
          label: s["strings.settings.overview.appearance.colors"],
          run: go("appearance", "Palette"),
        },
        problems && {
          label: s["strings.settings.overview.appearance.show_problems"],
          run: go("appearance", "Config file"),
        },
      ]}
    />
  );
}

function briefsLine(s: Strings): string {
  const mode = s["briefs.policy_mode"];
  return s[`strings.settings.overview.routing.briefs.${mode}`];
}

function RoutingOverview() {
  const s = useShell().settings;
  const go = useGo();
  const level = s["ai.level"];
  const sections = s["sections.rules"].filter((r) => !r.hidden).length;
  const automate = level === "automate";
  return (
    <OverviewCard
      section="routing"
      lines={[
        level === "off"
          ? s["strings.settings.overview.routing.off"]
          : level === "assist"
            ? s["strings.settings.overview.routing.assist"]
            : s["routing.on_arrival"]
              ? s["strings.settings.overview.routing.on"]
              : s["strings.settings.overview.routing.manual"],
        automate && briefsLine(s),
        fill(s["strings.settings.overview.routing.sections"], { n: sections }),
      ]}
      actions={[
        {
          label: s["strings.settings.overview.routing.edit_sections"],
          run: go("routing", "sections.rules"),
        },
        automate && {
          label: s["strings.settings.overview.routing.briefs_action"],
          run: go("routing", "Briefs"),
        },
      ]}
    />
  );
}

const CLI_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function AiOverview() {
  const s = useShell().settings;
  const go = useGo();
  const { onDevice, shared } = useKeyState();
  const level: AiLevel = s["ai.level"];
  if (level === "off") return null;
  const has = (p: string) => onDevice.has(p as never) || shared.has(p as never);
  const provider = s["ai.hosted.provider"];
  const hosted = s["ai.mode"] === "hosted";
  const keys = HOSTED_PROVIDERS.filter(has).length;
  const judge = s["ai.judge.provider"] !== "llm" && has("typesafe");
  return (
    <OverviewCard
      section="ai"
      lines={[
        hosted
          ? has(provider)
            ? fill(s["strings.settings.overview.ai.hosted"], {
                provider: PROVIDER_LABELS[provider],
                model: s[`ai.roles.${provider}`].main,
              })
            : fill(s["strings.settings.overview.ai.hosted_nokey"], {
                provider: PROVIDER_LABELS[provider],
              })
          : fill(s["strings.settings.overview.ai.local"], {
              cli: CLI_LABEL[s["ai.local.cli"]] ?? s["ai.local.cli"],
            }),
        levelAtLeast(level, "automate") &&
          (judge
            ? s["strings.settings.overview.ai.typesafe"]
            : s["strings.settings.overview.ai.llm"]),
        keys === 0
          ? s["strings.settings.overview.ai.keys_none"]
          : keys === 1
            ? s["strings.settings.overview.ai.keys_one"]
            : fill(s["strings.settings.overview.ai.keys_many"], { n: keys }),
      ]}
      actions={[
        { label: s["strings.settings.overview.ai.runtime"], run: go("ai", "Runtime") },
        hosted &&
          !has(provider) && {
            label: s["strings.settings.overview.ai.add_key"],
            run: go("ai", `ai.share_key.${provider}`),
          },
        { label: s["strings.settings.overview.ai.usage"], run: go("ai", "Meter") },
      ]}
    />
  );
}

function WorkflowsOverview() {
  const s = useShell().settings;
  const go = useGo();
  if (!levelAtLeast(s["ai.level"], "automate")) {
    return (
      <OverviewCard
        section="workflows"
        lines={[s["strings.settings.overview.workflows.locked"]]}
        actions={[
          { label: s["strings.settings.overview.workflows.raise"], run: go("ai", "Level") },
        ]}
      />
    );
  }
  return (
    <OverviewCard
      section="workflows"
      lines={[
        s["workflows.placement"] === "server"
          ? s["strings.settings.overview.workflows.server"]
          : s["strings.settings.overview.workflows.local"],
        fill(s["strings.settings.overview.workflows.tools"], {
          n: s["workflows.mcp_servers"].length,
        }),
      ]}
      actions={[
        {
          label: s["strings.settings.overview.workflows.add_tool"],
          run: go("workflows", "workflows.mcp_servers"),
        },
      ]}
    />
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ServerOverview() {
  const shell = useShell();
  const s = shell.settings;
  const go = useGo();
  const cloud = shell.server?.kind === "cloud";
  return (
    <OverviewCard
      section="server"
      lines={[
        !shell.server
          ? s["strings.settings.overview.server.none"]
          : cloud
            ? fill(s["strings.settings.overview.server.cloud"], {
                host: hostOf(shell.server.target.baseUrl),
              })
            : s["strings.settings.overview.server.sidecar"],
      ]}
      actions={[
        {
          label: s["strings.settings.overview.server.check"],
          run: () => void shell.refreshServers(),
        },
        !shell.cloud && {
          label: s["strings.settings.overview.server.cloud_action"],
          run: go("server", "Cloud"),
        },
        { label: s["strings.settings.overview.server.devices"], run: go("server", "Devices") },
      ]}
    />
  );
}

function ShortcutsOverview() {
  const s = useShell().settings;
  const go = useGo();
  const changed = Object.keys(s["keyboard.bindings"]).length;
  return (
    <OverviewCard
      section="shortcuts"
      lines={[
        fill(s["strings.settings.overview.shortcuts.line"], {
          keymap: optionLabel(s["keyboard.keymap"]),
        }),
        changed > 0 && fill(s["strings.settings.overview.shortcuts.changed"], { n: changed }),
      ]}
      actions={[
        {
          label: s["strings.settings.overview.shortcuts.edit"],
          run: go("shortcuts", "keyboard.bindings"),
        },
      ]}
    />
  );
}

const BY_SECTION: Partial<Record<SettingSection, () => ReactNode>> = {
  accounts: AccountsOverview,
  appearance: AppearanceOverview,
  routing: RoutingOverview,
  ai: AiOverview,
  workflows: WorkflowsOverview,
  server: ServerOverview,
  shortcuts: ShortcutsOverview,
};

for (const [section, Component] of Object.entries(BY_SECTION)) {
  overviews[section as SettingSection] = () => <Component />;
}
