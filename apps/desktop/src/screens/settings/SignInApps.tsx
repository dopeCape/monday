// Settings › Accounts › Sign-in apps: the app-level half of the Accounts page.
// Google and Microsoft accounts sign in through an OAuth app the self-hoster
// registers once (ADR 0008); this block holds one card per provider saying
// whether it is set up, with Set up, Replace and Remove. The paste form checks
// the registration live through the Server and saves it the moment the check
// passes, so nothing typed is lost to a failed sign-in or a closed window.
// The secret is sent once and never shown again: the Server answers only
// whether it keeps one. Changes raise OAUTH_APP_CHANGED so an open wizard
// reads the app again; the wizard's own saves raise it too, and this block
// re-reads on it.

import { Btn, Input, Seg } from "@monday/ui";
import {
  CheckCircleIcon,
  GoogleLogoIcon,
  WarningCircleIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { Api, OAuthAppView, OAuthProvider, ValidationResult } from "../../platform/api.ts";
import { useShell } from "../../shell/Shell.tsx";
import { Card, DangerAction, messageOf, type PanelProps } from "./render.tsx";
import { fill, OAUTH_APP_CHANGED } from "./wizard.ts";

const PROVIDERS: readonly OAuthProvider[] = ["google", "microsoft"];

const LOGO: Record<OAuthProvider, ReactNode> = {
  google: <GoogleLogoIcon />,
  microsoft: <WindowsLogoIcon />,
};

const LABEL: Record<OAuthProvider, string> = { google: "Google", microsoft: "Microsoft" };

export interface SignInAppsProps extends Partial<PanelProps> {
  /** Test seam; the Shell's api by default. */
  api?: Api | undefined;
  /** Debounce for the live check on paste. */
  debounceMs?: number | undefined;
}

type Loaded = Record<OAuthProvider, OAuthAppView | null>;

/** The Sign-in apps block: one card per provider, each set up, replaced or removed in place. */
export function SignInAppsPanel(props: SignInAppsProps) {
  const shell = useShell();
  const api = props.api ?? shell.api;
  const s = shell.settings;
  const [apps, setApps] = useState<Loaded | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const read = useCallback(async () => {
    try {
      const [google, microsoft] = await Promise.all(PROVIDERS.map((p) => api.oauth.app(p)));
      setApps({ google: google?.app ?? null, microsoft: microsoft?.app ?? null });
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, [api]);
  useEffect(() => {
    void read();
    const onChange = () => void read();
    window.addEventListener(OAUTH_APP_CHANGED, onChange);
    return () => window.removeEventListener(OAUTH_APP_CHANGED, onChange);
  }, [read]);

  return (
    <div className="stack sign-in-apps" data-panel="sign-in-apps">
      {unreachable ? <div className="note">{s["strings.oauth_apps.unreachable"]}</div> : null}
      {PROVIDERS.map((p) => (
        <AppCard
          key={p}
          provider={p}
          app={apps?.[p] ?? null}
          loading={apps === null && !unreachable}
          api={api}
          debounceMs={props.debounceMs ?? 400}
        />
      ))}
    </div>
  );
}

const changed = () => window.dispatchEvent(new Event(OAUTH_APP_CHANGED));

function AppCard({
  provider,
  app,
  loading,
  api,
  debounceMs,
}: {
  provider: OAuthProvider;
  app: OAuthAppView | null;
  loading: boolean;
  api: Api;
  debounceMs: number;
}) {
  const s = useShell().settings;
  const [editing, setEditing] = useState(false);
  const status = app
    ? s[`strings.oauth_apps.${provider}.ready`]
    : s[`strings.oauth_apps.${provider}.missing`];
  return (
    <Card
      title={
        <span className="with-mark">
          <span className="lg">{LOGO[provider]}</span>
          {s[`strings.oauth_apps.${provider}`]}
        </span>
      }
      hint={loading ? undefined : status}
      block={editing}
      attrs={{ "data-oauth-app": provider, "data-state": app ? "ready" : "missing" }}
      foot={
        app ? (
          <>
            <span className="mono">
              {fill(s["strings.oauth_apps.client_line"], { client: app.clientId })}
            </span>
            {app.hasSecret ? <span>{s["strings.oauth_apps.secret_kept"]}</span> : null}
          </>
        ) : undefined
      }
    >
      {editing ? (
        <AppForm
          provider={provider}
          app={app}
          api={api}
          debounceMs={debounceMs}
          onSaved={changed}
          onCancel={() => setEditing(false)}
        />
      ) : loading ? null : (
        <span className="key-row">
          <Btn sm primary={!app} onClick={() => setEditing(true)}>
            {app ? s["strings.oauth_apps.replace"] : s["strings.oauth_apps.set_up"]}
          </Btn>
          {app ? (
            <DangerAction
              label={s["strings.oauth_apps.remove"]}
              confirm={fill(s["strings.oauth_apps.remove_confirm"], { provider: LABEL[provider] })}
              onConfirm={async () => {
                try {
                  await api.oauth.removeApp(provider);
                } catch (e) {
                  throw new Error(fill(s["strings.oauth_apps.failed"], { message: messageOf(e) }));
                }
                changed();
              }}
            />
          ) : null}
        </span>
      )}
    </Card>
  );
}

interface Draft {
  clientId: string;
  clientSecret: string;
  pubsubTopic: string;
  accountType: "personal" | "work";
  tenant: string;
}

type Check =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "error"; result: Extract<ValidationResult, { ok: false }> }
  | { status: "failed"; message: string }
  | { status: "saved" };

/**
 * The paste form: checked live through the Server after the last keystroke
 * and saved the moment the check passes; the form stays open with Done so
 * the optional topic can follow, saved on leaving its box. Replace starts
 * empty: the saved secret is never sent back to fill it.
 */
function AppForm({
  provider,
  app,
  api,
  debounceMs,
  onSaved,
  onCancel,
}: {
  provider: OAuthProvider;
  app: OAuthAppView | null;
  api: Api;
  debounceMs: number;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const s = useShell().settings;
  const [draft, setDraft] = useState<Draft>(() => ({
    clientId: "",
    clientSecret: "",
    pubsubTopic: app?.pubsubTopic ?? "",
    accountType: app?.accountType ?? "personal",
    tenant: app?.tenant && app.tenant !== "consumers" ? app.tenant : "",
  }));
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const seq = useRef(0);
  const tenant = draft.accountType === "personal" ? "consumers" : draft.tenant.trim();
  const ready =
    draft.clientId.trim() !== "" &&
    (provider === "google" ? draft.clientSecret.trim() !== "" : tenant !== "");
  // The fields the check runs on; the optional topic rides along without re-checking.
  const key = `${draft.clientId.trim()}|${draft.clientSecret.trim()}|${tenant}`;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the check runs again only when the checked fields change
  useEffect(() => {
    if (!ready) {
      setCheck({ status: "idle" });
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setCheck({ status: "checking" });
      const d = draftRef.current;
      try {
        const { result } = await api.oauth.saveApp(
          provider,
          provider === "google"
            ? {
                clientId: d.clientId.trim(),
                clientSecret: d.clientSecret.trim(),
                pubsubTopic: d.pubsubTopic.trim() || null,
                projectId: app?.projectId ?? null,
              }
            : { clientId: d.clientId.trim(), tenant, accountType: d.accountType },
        );
        if (mine !== seq.current) return;
        if (result.ok) {
          setCheck({ status: "saved" });
          onSaved();
        } else setCheck({ status: "error", result });
      } catch (e) {
        if (mine === seq.current) setCheck({ status: "failed", message: messageOf(e) });
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [key, ready]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const bad = (field: string) =>
    check.status === "error" && check.result.field === field ? "bad" : "";
  return (
    <div className="wizard-fields sign-in-form">
      <Field
        label={
          provider === "google"
            ? s["strings.accounts.google.client_id"]
            : s["strings.accounts.microsoft.client_id"]
        }
      >
        {(id) => (
          <Input
            id={id}
            className={bad("clientId")}
            value={draft.clientId}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set({ clientId: e.target.value })}
          />
        )}
      </Field>
      {provider === "google" ? (
        <>
          <Field label={s["strings.accounts.google.client_secret"]}>
            {(id) => (
              <Input
                id={id}
                type="password"
                className={bad("clientSecret")}
                value={draft.clientSecret}
                autoComplete="off"
                onChange={(e) => set({ clientSecret: e.target.value })}
              />
            )}
          </Field>
          <Field label={s["strings.oauth_apps.pubsub_optional"]}>
            {(id) => (
              <Input
                id={id}
                value={draft.pubsubTopic}
                placeholder="projects/your-project/topics/monday-gmail"
                spellCheck={false}
                onChange={(e) => set({ pubsubTopic: e.target.value })}
                onBlur={() => {
                  if (check.status !== "saved") return;
                  void api.oauth
                    .updateApp(provider, { pubsubTopic: draft.pubsubTopic.trim() || null })
                    .then(onSaved)
                    .catch((e: unknown) => setCheck({ status: "failed", message: messageOf(e) }));
                }}
              />
            )}
          </Field>
        </>
      ) : (
        <>
          <Field label={s["strings.oauth_apps.account_type"]}>
            {() => (
              <Seg<"personal" | "work">
                options={[
                  { value: "personal", label: s["strings.accounts.microsoft.personal"] },
                  { value: "work", label: s["strings.accounts.microsoft.work"] },
                ]}
                value={draft.accountType}
                onChange={(accountType) => set({ accountType })}
              />
            )}
          </Field>
          {draft.accountType === "work" ? (
            <Field label={s["strings.accounts.microsoft.tenant"]}>
              {(id) => (
                <Input
                  id={id}
                  className={bad("tenant")}
                  value={draft.tenant}
                  spellCheck={false}
                  onChange={(e) => set({ tenant: e.target.value })}
                />
              )}
            </Field>
          ) : null}
        </>
      )}
      <div className="sign-in-foot">
        {check.status === "checking" ? (
          <span className="wizard-check checking" role="status">
            {s["strings.accounts.wizard.checking"]}
          </span>
        ) : check.status === "error" ? (
          <span className="wizard-check bad" role="alert">
            <WarningCircleIcon /> {check.result.reason}
          </span>
        ) : check.status === "failed" ? (
          <span className="wizard-check bad" role="alert">
            <WarningCircleIcon /> {fill(s["strings.oauth_apps.failed"], { message: check.message })}
          </span>
        ) : check.status === "saved" ? (
          <span className="wizard-check ok" role="status">
            <CheckCircleIcon /> {fill(s["strings.oauth_apps.saved"], { provider: LABEL[provider] })}
          </span>
        ) : (
          <span className="wizard-check" />
        )}
        <Btn sm primary={check.status === "saved"} onClick={onCancel}>
          {check.status === "saved"
            ? s["strings.accounts.wizard.done"]
            : s["strings.oauth_apps.cancel"]}
        </Btn>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="wizard-field">
      <label className="wizard-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}
