// Settings › Accounts, the Accounts panel (docs/spec/settings.md "Accounts"):
// the connected Accounts as cards with the provider mark, address, push or
// polling, last sync and last error, each with a Remove that asks first and
// says what is deleted; and "Connect an account", the four provider cards
// with what each needs, which open the wizard (AddAccount.tsx) inline. This
// is also the first-run screen (main.tsx shows it alone until an Account
// exists), so it welcomes rather than lists.

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
import {
  Card,
  DangerAction,
  messageOf,
  type PanelProps,
  registerPanel,
  useSettingsScreen,
} from "./render.tsx";
import { fill } from "./wizard.ts";

const PROVIDER_LOGO: Record<string, ReactNode> = {
  gmail: <GoogleLogoIcon />,
  graph: <WindowsLogoIcon />,
  jmap: "FM",
  imap: <EnvelopeSimpleIcon />,
};

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
          attrs={{ "data-account": a.id }}
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
registerPanel("accounts", "Accounts", AccountsPanel, {
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
