// Settings › Accounts, the "Your accounts" panel (docs/spec/settings.md
// "Accounts"): each connected Account as a card with the provider mark,
// address, push or polling, last sync and last error, and the settings that
// belong to that Account alone behind one disclosure in its card: its own
// signature and meeting link (the per-Account maps), its CalDAV calendar and
// its Voice profile. Remove asks first and says what is deleted. "Connect an
// account", the four provider cards with what each needs, opens the wizard
// (AddAccount.tsx) inline. This is also the first-run screen (main.tsx shows
// it alone until an Account exists), so it welcomes rather than lists. The
// settings shared by every Account live in the groups below this one.

import { describeSetting, settingsSchema } from "@monday/shared";
import { formatWhen, Tag } from "@monday/ui";
import {
  EnvelopeSimpleIcon,
  GoogleLogoIcon,
  PlusIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AccountView } from "../../platform/api.ts";
import { useShell } from "../../shell/Shell.tsx";
import { AddAccount, type AddAccountView } from "./AddAccount.tsx";
import { Disclosure } from "./disclosure.tsx";
import { CalDavLink, VoiceCard } from "./panels.tsx";
import {
  Card,
  DangerAction,
  messageOf,
  optionLabel,
  type PanelProps,
  Pinned,
  registerPanel,
  useDraft,
  useSetting,
  useSettingsScreen,
} from "./render.tsx";
import { SignInAppsPanel } from "./SignInApps.tsx";
import { fill } from "./wizard.ts";

const PROVIDER_LOGO: Record<string, ReactNode> = {
  gmail: <GoogleLogoIcon />,
  graph: <WindowsLogoIcon />,
  jmap: "FM",
  imap: <EnvelopeSimpleIcon />,
};

/** This Account's own signature: an entry of `send.signatures`, the shared one as its placeholder. */
function AccountSignature({ address }: { address: string }) {
  const { value, change, error, shell } = useSetting("send.signatures");
  const s = shell.settings;
  const entry = settingsSchema["send.signatures"];
  const map = value as Record<string, string>;
  const d = useDraft(map[address] ?? "", (text) => {
    const next = { ...map };
    if (text.trim()) next[address] = text;
    else delete next[address];
    return change(next);
  });
  return (
    <Card
      title={entry.label}
      hint={entry.help}
      block
      attrs={{
        "data-setting": "send.signatures",
        "data-account": address,
        "data-pinned": shell.pinned.has("send.signatures") ? "true" : undefined,
      }}
      foot={
        error ? (
          <span className="err">{fill(s["strings.settings.invalid"], { message: error })}</span>
        ) : undefined
      }
    >
      <Pinned k="send.signatures">
        <textarea
          className="input area"
          rows={3}
          value={d.draft}
          placeholder={s["send.signature"] || s["strings.settings.accounts.shared"]}
          onChange={(e) => d.onChange(e.target.value)}
          onBlur={d.flush}
        />
      </Pinned>
    </Card>
  );
}

/** This Account's own meeting link: an entry of `calendar.meeting_links`, or the shared choice. */
function AccountMeetingLink({ address }: { address: string }) {
  const { value, change, error, shell } = useSetting("calendar.meeting_links");
  const s = shell.settings;
  const entry = settingsSchema["calendar.meeting_links"];
  const map = value as Record<string, string>;
  const shape = describeSetting("calendar.meeting_link");
  const options = shape.kind === "enum" ? shape.options : [];
  const shared = fill(s["strings.settings.accounts.card.meeting_shared"], {});
  return (
    <Card
      title={entry.label}
      hint={entry.help}
      attrs={{
        "data-setting": "calendar.meeting_links",
        "data-account": address,
        "data-pinned": shell.pinned.has("calendar.meeting_links") ? "true" : undefined,
      }}
      foot={
        error ? (
          <span className="err">{fill(s["strings.settings.invalid"], { message: error })}</span>
        ) : undefined
      }
    >
      <Pinned k="calendar.meeting_links">
        <select
          className="select"
          aria-label={entry.label}
          value={map[address] ?? ""}
          onChange={(e) => {
            const next = { ...map };
            if (e.target.value) next[address] = e.target.value;
            else delete next[address];
            void change(next);
          }}
        >
          <option value="">{`${shared} (${optionLabel(s["calendar.meeting_link"])})`}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {optionLabel(o)}
            </option>
          ))}
        </select>
      </Pinned>
    </Card>
  );
}

/** Everything that belongs to one Account alone, inside its card. */
function AccountSettings({ account }: { account: AccountView }) {
  const s = useShell().settings;
  return (
    <div className="stack account-settings">
      <AccountSignature address={account.address} />
      <AccountMeetingLink address={account.address} />
      {account.capabilities.calendar ? (
        <Card
          title={s["strings.settings.accounts.card.calendar"]}
          hint={s["strings.settings.accounts.card.calendar_native"]}
        />
      ) : (
        <CalDavLink account={account} />
      )}
      <VoiceCard workspaceId={account.workspaceId} />
    </div>
  );
}
/** The connected Accounts, and the way to connect one. */
export function AccountsPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [adding, setAdding] = useState<AddAccountView | null>(null);
  // The last provider opened; the form stays mounted so what was typed survives Back.
  const [opened, setOpened] = useState<AddAccountView | null>(null);
  const [added, setAdded] = useState<AccountView | null>(null);
  const refresh = useCallback(() => {
    shell.api.accounts
      .list()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
  }, [shell.api]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const list = accounts ?? [];
  const native = (a: AccountView) => a.capabilities.push || a.provider === "gmail";
  const line = (a: AccountView) =>
    [
      a.provider,
      a.capabilities.push ? s["strings.accounts.push"] : s["strings.accounts.polling"],
      native(a) ? s["strings.settings.accounts.native"] : s["strings.settings.accounts.emulated"],
      a.lastSync
        ? fill(s["strings.settings.accounts.last_sync"], {
            when: formatWhen(a.lastSync, screen.now()),
          })
        : s["strings.settings.accounts.never"],
    ].join(" · ");

  return (
    <div className="stack" data-panel="accounts">
      {added ? (
        <div className="note ok" data-panel="account-added">
          {fill(s["strings.accounts.added"], { address: added.address })}
        </div>
      ) : null}
      {list.map((a) => (
        <Card
          key={a.id}
          title={
            <span className="with-mark">
              <span className="lg">{PROVIDER_LOGO[a.provider] ?? "@"}</span>
              {a.address}
            </span>
          }
          hint={line(a)}
          danger
          className="account-card"
          attrs={{ "data-account": a.id }}
          below={
            <Disclosure
              id={`accounts/account/${a.id}`}
              className="more account-more"
              summary={s["strings.settings.accounts.card.settings"]}
            >
              <AccountSettings account={a} />
            </Disclosure>
          }
          foot={
            <>
              {a.lastError ? (
                <span className="err">
                  {fill(s["strings.accounts.error_line"], { message: a.lastError })}
                </span>
              ) : (
                <span>{s["strings.accounts.remove_help"]}</span>
              )}
              <span className="sp" />
              <DangerAction
                label={s["strings.accounts.remove"]}
                confirm={fill(s["strings.accounts.remove_confirm"], { address: a.address })}
                onConfirm={async () => {
                  try {
                    await shell.api.accounts.remove(a.id);
                  } catch (e) {
                    throw new Error(
                      fill(s["strings.accounts.remove_failed"], { message: messageOf(e) }),
                    );
                  }
                  refresh();
                }}
              />
            </>
          }
        >
          <Tag kind={a.connected && !a.lastError ? "ok" : "warn"}>
            {a.lastError
              ? s["strings.server.health.down"]
              : a.connected
                ? s["strings.accounts.connected"]
                : s["strings.accounts.syncing"]}
          </Tag>
        </Card>
      ))}
      {opened ? (
        <div
          className="scard sheet"
          data-panel={adding ? "add-account" : "add-account-closed"}
          hidden={!adding}
        >
          <AddAccount
            initial={adding ?? opened}
            onCancel={() => setAdding(null)}
            onAdded={(account) => {
              setAdded(account);
              refresh();
            }}
            onDone={() => setAdding(null)}
          />
        </div>
      ) : null}
      {adding ? null : (
        <Connect
          first={accounts !== null && list.length === 0}
          onPick={(view) => {
            setAdded(null);
            setOpened(view);
            setAdding(view);
          }}
        />
      )}
    </div>
  );
}
// The app-level half of Accounts: the Google and Microsoft sign-in apps every
// Account of that provider signs in through (SignInApps.tsx).
registerPanel("accounts", "Sign-in apps", SignInAppsPanel, {
  title: "strings.oauth_apps.title",
  description: "strings.oauth_apps.intro",
  searchTerms: [
    "sign-in",
    "oauth",
    "client id",
    "client secret",
    "google cloud",
    "azure",
    "app registration",
    "tenant",
    "pub/sub",
  ],
});

registerPanel("accounts", "Your accounts", AccountsPanel, {
  title: "strings.accounts.connect.title",
  description: "strings.accounts.connect.intro",
  searchTerms: [
    "accounts",
    "connect",
    "add account",
    "gmail",
    "google",
    "microsoft",
    "outlook",
    "fastmail",
    "jmap",
    "imap",
    "remove",
    "sync",
  ],
});

/** "Connect an account": the four provider cards with what each needs. */
function Connect({ first, onPick }: { first: boolean; onPick: (view: AddAccountView) => void }) {
  const s = useShell().settings;
  const cards: Array<{ view: AddAccountView; logo: ReactNode; title: string; needs: string }> = [
    {
      view: "jmap",
      logo: "FM",
      title: s["strings.accounts.pick.fastmail"],
      needs: s["strings.accounts.pick.fastmail_needs"],
    },
    {
      view: "imap",
      logo: <EnvelopeSimpleIcon />,
      title: s["strings.accounts.pick.imap"],
      needs: s["strings.accounts.pick.imap_needs"],
    },
    {
      view: "google",
      logo: <GoogleLogoIcon />,
      title: s["strings.accounts.pick.google"],
      needs: s["strings.accounts.pick.google_needs"],
    },
    {
      view: "microsoft",
      logo: <WindowsLogoIcon />,
      title: s["strings.accounts.pick.microsoft"],
      needs: s["strings.accounts.pick.microsoft_needs"],
    },
  ];
  return (
    <div className="connect" data-panel="connect">
      <div className="connect-head">
        <h2 className="connect-title">
          {first ? s["strings.accounts.connect.title"] : s["strings.accounts.connect.another"]}
        </h2>
        <p>{s["strings.accounts.connect.intro"]}</p>
      </div>
      <div className="providers">
        {cards.map((c) => (
          <button
            type="button"
            className="prov big"
            key={c.view}
            data-provider={c.view}
            onClick={() => onPick(c.view)}
          >
            <span className="lg">{c.logo}</span>
            <div>
              <b>{c.title}</b>
              <span>{c.needs}</span>
            </div>
            <span className="st">
              <PlusIcon />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
