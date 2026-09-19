// Settings › Accounts › Add account: the provider picker and the four paths
// (docs/spec/settings.md, "Accounts"; ADR 0008). Fastmail or JMAP is a token
// paste, IMAP runs autoconfig and hands Gmail and Microsoft domains to their
// wizards, and the Google and Microsoft wizards walk the self-hoster through
// creating their own client registration: one sentence and one action per
// step, deep links into the consoles, a live-validated paste box, then a
// sign-in that waits on the Sidecar's loopback listener. The state machine is
// wizard.ts; this file only renders it and talks to the server.

import { Btn, Input, Tag } from "@monday/ui";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  EnvelopeSimpleIcon,
  GoogleLogoIcon,
  WarningCircleIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AccountView,
  type Api,
  ApiError,
  type Discovery,
  type HostPort,
  type OAuthProvider,
} from "../../platform/api.ts";
import { platform } from "../../platform/tauri.ts";
import { useShell } from "../../shell/Shell.tsx";
import {
  canAdvance,
  canSkip,
  canValidate,
  deepLink,
  effectiveTenant,
  elapsedMs,
  fill,
  formatElapsed,
  GMAIL_PUBLISHER,
  initialWizard,
  reduceWizard,
  stepIndex,
  suggestedTopic,
  targetMinutes,
  validationKey,
  type WizardAction,
  type WizardProvider,
  type WizardState,
} from "./wizard.ts";

export type AddAccountView = "pick" | "jmap" | "imap" | "google" | "microsoft";

export interface AddAccountProps {
  /** Where to open; the picker by default. */
  initial?: AddAccountView | undefined;
  onAdded?: ((account: AccountView) => void) | undefined;
  onCancel?: (() => void) | undefined;
  /** Done after an Account was added; back to the picker when absent. */
  onDone?: (() => void) | undefined;
  /** Test seams: default to the Shell's api and the platform's browser opener. */
  api?: Api | undefined;
  openExternal?: ((url: string) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** Debounce for the live validation on paste. */
  validateDebounceMs?: number | undefined;
  /** Pause between status polls while the browser is open. */
  pollMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

/** What the JMAP form holds; kept here so Back to the picker keeps it. */
interface JmapDraft {
  address: string;
  sessionUrl: string;
  token: string;
}

/** What the IMAP form holds; kept here so Back to the picker keeps it. */
interface ImapDraft {
  address: string;
  password: string;
  discovery: Discovery | null;
  imap: HostPort;
  smtp: HostPort;
  username: string;
}

export function AddAccount(props: AddAccountProps) {
  const shell = useShell();
  const api = props.api ?? shell.api;
  const now = props.now ?? (() => Date.now());
  const [view, setView] = useState<AddAccountView>(props.initial ?? "pick");
  const [done, setDone] = useState<AccountView | null>(null);
  // Opened again at another provider: show that one, with a fresh outcome.
  const initial = props.initial;
  useEffect(() => {
    if (initial) {
      setView(initial);
      setDone(null);
    }
  }, [initial]);
  const [jmap, setJmap] = useState<JmapDraft>({
    address: "",
    sessionUrl: "https://api.fastmail.com/jmap/session",
    token: "",
  });
  const [imap, setImap] = useState<ImapDraft>({
    address: "",
    password: "",
    discovery: null,
    imap: DEFAULT_IMAP,
    smtp: DEFAULT_SMTP,
    username: "",
  });
  const [wizards, setWizards] = useState<Record<WizardProvider, WizardState>>(() => ({
    google: initialWizard("google", now()),
    microsoft: initialWizard("microsoft", now()),
  }));
  const dispatchers = useMemo(() => {
    const forProvider = (p: WizardProvider) => (action: WizardAction) =>
      setWizards((w) => ({ ...w, [p]: reduceWizard(w[p], action) }));
    return { google: forProvider("google"), microsoft: forProvider("microsoft") };
  }, []);
  const s = shell.settings;
  const openExternal =
    props.openExternal ?? (async (url: string) => (await platform()).openExternal(url));
  const finish = props.onDone ?? (() => setView("pick"));
  // Opened straight at a provider from the Connect cards: Back leaves to them, not to an inner picker.
  const back = props.initial && props.onCancel ? props.onCancel : () => setView("pick");
  const added = (account: AccountView) => {
    setDone(account);
    props.onAdded?.(account);
  };

  if (done) {
    return (
      <div className="wizard" data-step="done">
        <div className="wizard-step">
          <div className="wizard-done">
            <b>
              <CheckCircleIcon /> {fill(s["strings.accounts.added"], { address: done.address })}
            </b>
          </div>
        </div>
        <div className="wizard-foot">
          <div />
          <div>
            <Btn primary onClick={finish}>
              {s["strings.accounts.wizard.done"]}
            </Btn>
          </div>
        </div>
      </div>
    );
  }
  if (view === "pick") {
    return (
      <>
        <h1>{s["strings.accounts.pick.title"]}</h1>
        <div className="providers">
          <ProviderCard
            logo="FM"
            title={s["strings.accounts.pick.fastmail"]}
            sub={s["strings.accounts.pick.fastmail_sub"]}
            onClick={() => setView("jmap")}
          />
          <ProviderCard
            logo={<EnvelopeSimpleIcon />}
            title={s["strings.accounts.pick.imap"]}
            sub={s["strings.accounts.pick.imap_sub"]}
            onClick={() => setView("imap")}
          />
          <ProviderCard
            logo={<GoogleLogoIcon />}
            title={s["strings.accounts.pick.google"]}
            sub={s["strings.accounts.pick.google_sub"]}
            onClick={() => setView("google")}
          />
          <ProviderCard
            logo={<WindowsLogoIcon />}
            title={s["strings.accounts.pick.microsoft"]}
            sub={s["strings.accounts.pick.microsoft_sub"]}
            onClick={() => setView("microsoft")}
          />
        </div>
        {props.onCancel ? (
          <div className="wizard-foot" style={{ marginTop: 20 }}>
            <div>
              <Btn onClick={props.onCancel}>{s["strings.accounts.wizard.back"]}</Btn>
            </div>
          </div>
        ) : null}
      </>
    );
  }
  if (view === "jmap") {
    return <JmapForm api={api} draft={jmap} onDraft={setJmap} onAdded={added} onBack={back} />;
  }
  if (view === "imap") {
    return (
      <ImapForm
        api={api}
        draft={imap}
        onDraft={setImap}
        onAdded={added}
        onBack={back}
        onOAuth={(issuer) => setView(issuer)}
      />
    );
  }
  return (
    <Wizard
      key={view}
      provider={view}
      state={wizards[view]}
      dispatch={dispatchers[view]}
      api={api}
      openExternal={openExternal}
      now={now}
      validateDebounceMs={props.validateDebounceMs ?? 400}
      pollMs={props.pollMs ?? 500}
      log={props.log ?? ((line) => console.debug(line))}
      onAdded={props.onAdded}
      onBack={back}
      onDone={finish}
      onEscape={() => {
        // The escape is consumed: coming back to this wizard later starts where it left off.
        setWizards((w) => ({ ...w, [view]: { ...w[view], escaped: false } }));
        setView("imap");
      }}
    />
  );
}

function ProviderCard({
  logo,
  title,
  sub,
  onClick,
}: {
  logo: ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="prov" onClick={onClick}>
      <div className="lg">{logo}</div>
      <div>
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <span />
    </button>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.message) as { message?: string; error?: string };
      return body.message ?? body.error ?? error.message;
    } catch {
      return error.message || `HTTP ${error.status}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------ JMAP (token paste) ------------------------------ */

function JmapForm({
  api,
  draft,
  onDraft,
  onAdded,
  onBack,
}: {
  api: Api;
  draft: JmapDraft;
  onDraft: (next: JmapDraft) => void;
  onAdded: (account: AccountView) => void;
  onBack: () => void;
}) {
  const s = useShell().settings;
  const { address, sessionUrl, token } = draft;
  const setAddress = (address: string) => onDraft({ ...draft, address });
  const setSessionUrl = (sessionUrl: string) => onDraft({ ...draft, sessionUrl });
  const setToken = (token: string) => onDraft({ ...draft, token });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { account } = await api.accounts.add({
        provider: "jmap",
        address: address.trim(),
        auth: { kind: "token", token: token.trim() },
        endpoint: { kind: "jmap", sessionUrl: sessionUrl.trim() },
      });
      onAdded(account);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wizard">
      <div className="wizard-head">
        <h1>{s["strings.accounts.pick.fastmail"]}</h1>
      </div>
      <div className="wizard-step">
        <p className="wizard-sentence">{s["strings.accounts.jmap.help"]}</p>
        <div className="wizard-fields">
          <Field label={s["strings.accounts.imap.address"]}>
            <FieldInput value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label={s["strings.accounts.jmap.session_url"]}>
            <FieldInput value={sessionUrl} onChange={(e) => setSessionUrl(e.target.value)} />
          </Field>
          <Field label={s["strings.accounts.jmap.token"]}>
            <FieldInput type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        </div>
        {error ? (
          <div className="wizard-check bad">
            <WarningCircleIcon /> {error}
          </div>
        ) : null}
      </div>
      <div className="wizard-foot">
        <div>
          <Btn onClick={onBack}>{s["strings.accounts.wizard.back"]}</Btn>
        </div>
        <div>
          <Btn primary disabled={busy || !address || !token} onClick={() => void connect()}>
            {busy ? s["strings.accounts.connecting"] : s["strings.accounts.connect"]}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ IMAP (autoconfig, then manual) ------------------------------ */

const DEFAULT_IMAP: HostPort = { host: "", port: 993, tls: "tls" };
const DEFAULT_SMTP: HostPort = { host: "", port: 465, tls: "tls" };

function ImapForm({
  api,
  draft,
  onDraft,
  onAdded,
  onBack,
  onOAuth,
}: {
  api: Api;
  draft: ImapDraft;
  onDraft: (next: ImapDraft) => void;
  onAdded: (account: AccountView) => void;
  onBack: () => void;
  onOAuth: (issuer: OAuthProvider, address: string) => void;
}) {
  const s = useShell().settings;
  const { address, password, discovery, imap, smtp, username } = draft;
  const patch = (next: Partial<ImapDraft>) => onDraft({ ...draft, ...next });
  const setPassword = (password: string) => patch({ password });
  const setImap = (imap: HostPort) => patch({ imap });
  const setSmtp = (smtp: HostPort) => patch({ smtp });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await api.accounts.discover(address.trim());
      if (found.kind === "found") {
        patch({ discovery: found, imap: found.imap, smtp: found.smtp, username: found.username });
      } else {
        patch({ discovery: found, username: address.trim() });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { account } = await api.accounts.add({
        provider: "imap",
        address: address.trim(),
        auth: { kind: "password", user: username || address.trim(), password },
        endpoint: { kind: "imap", imap, smtp },
      });
      onAdded(account);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const issuer = discovery?.kind === "needs-oauth" ? discovery.issuer : null;
  const providerName =
    issuer === "google" ? s["strings.accounts.pick.google"] : s["strings.accounts.pick.microsoft"];
  const manual = discovery?.kind === "manual";
  const ready = discovery?.kind === "found" || manual;

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h1>{s["strings.accounts.pick.imap"]}</h1>
      </div>
      <div className="wizard-step">
        <div className="wizard-fields">
          <Field label={s["strings.accounts.imap.address"]}>
            <div className="wizard-action">
              <FieldInput
                value={address}
                onChange={(e) => patch({ address: e.target.value, discovery: null })}
              />
              <Btn disabled={busy || !address.includes("@")} onClick={() => void find()}>
                {s["strings.accounts.imap.find"]}
              </Btn>
            </div>
          </Field>
          {issuer ? (
            <div className="wizard-check">
              <WarningCircleIcon />{" "}
              {fill(s["strings.accounts.imap.redirect"], { provider: providerName })}
            </div>
          ) : null}
          {discovery?.kind === "found" ? (
            <div className="wizard-check ok">
              <CheckCircleIcon />{" "}
              {fill(s["strings.accounts.imap.found"], { host: discovery.imap.host })}
            </div>
          ) : null}
          {manual ? (
            <div className="wizard-check">
              <WarningCircleIcon /> {s["strings.accounts.imap.manual"]}
            </div>
          ) : null}
          {ready ? (
            <>
              <Field label={s["strings.accounts.imap.host"]}>
                <div className="wizard-action">
                  <FieldInput
                    value={imap.host}
                    onChange={(e) => setImap({ ...imap, host: e.target.value })}
                  />
                  <FieldInput
                    style={{ width: 90 }}
                    value={String(imap.port)}
                    onChange={(e) => setImap({ ...imap, port: Number(e.target.value) || 993 })}
                  />
                </div>
              </Field>
              <Field label={s["strings.accounts.imap.smtp"]}>
                <div className="wizard-action">
                  <FieldInput
                    value={smtp.host}
                    onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
                  />
                  <FieldInput
                    style={{ width: 90 }}
                    value={String(smtp.port)}
                    onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) || 465 })}
                  />
                </div>
              </Field>
              <Field label={s["strings.accounts.imap.password"]}>
                <FieldInput
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </>
          ) : null}
        </div>
        {error ? (
          <div className="wizard-check bad">
            <WarningCircleIcon /> {error}
          </div>
        ) : null}
      </div>
      <div className="wizard-foot">
        <div>
          <Btn onClick={onBack}>{s["strings.accounts.wizard.back"]}</Btn>
        </div>
        <div>
          {issuer ? (
            <Btn primary onClick={() => onOAuth(issuer, address.trim())}>
              {s["strings.accounts.wizard.next"]}
            </Btn>
          ) : (
            <Btn
              primary
              disabled={busy || !ready || !password || !imap.host}
              onClick={() => void connect()}
            >
              {busy ? s["strings.accounts.connecting"] : s["strings.accounts.connect"]}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string | undefined;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="wizard-field">
      <label className="wizard-label" htmlFor={id}>
        {label}
      </label>
      <FieldId.Provider value={id}>{children}</FieldId.Provider>
      {help ? <span className="help">{help}</span> : null}
    </div>
  );
}

const FieldId = createContext("");

/** The Input a Field labels; the first one in a Field gets the label's id. */
function FieldInput(props: ComponentProps<typeof Input>) {
  const id = useContext(FieldId);
  return <Input id={id} {...props} />;
}

/* ------------------------------ The Google and Microsoft wizards ------------------------------ */

interface WizardProps {
  provider: WizardProvider;
  /** The step machine's state and dispatch, owned by AddAccount so Back to the picker keeps it. */
  state: WizardState;
  dispatch: (action: WizardAction) => void;
  api: Api;
  openExternal: (url: string) => Promise<void>;
  now: () => number;
  validateDebounceMs: number;
  pollMs: number;
  log: (line: string) => void;
  onAdded: ((account: AccountView) => void) | undefined;
  onBack: () => void;
  /** Done after the sign-in finished. */
  onDone: () => void;
  onEscape: () => void;
}

export function Wizard(props: WizardProps) {
  const { provider, api, now, state, dispatch } = props;
  const s = useShell().settings;
  const [copied, setCopied] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Live validation: debounce after the last keystroke, drop stale answers.
  const key = validationKey(state);
  const validatable = state.step === "paste" && canValidate(state);
  useEffect(() => {
    if (!validatable || state.validation.status !== "idle") return;
    const timer = setTimeout(async () => {
      dispatch({ type: "validate.start", key });
      const current = stateRef.current;
      const params =
        provider === "google"
          ? {
              clientId: current.fields.clientId.trim(),
              clientSecret: current.fields.clientSecret.trim(),
            }
          : { clientId: current.fields.clientId.trim(), tenant: effectiveTenant(current) };
      try {
        const result = await api.oauth.validate(provider, params);
        dispatch({ type: "validate.result", key, result });
      } catch (error) {
        dispatch({
          type: "validate.result",
          key,
          result: { ok: false, field: "network", reason: errorMessage(error) },
        });
      }
    }, props.validateDebounceMs);
    return () => clearTimeout(timer);
  }, [
    validatable,
    key,
    state.validation.status,
    provider,
    api,
    props.validateDebounceMs,
    dispatch,
  ]);

  // The IMAP escape hatch: the parent switches views once the reducer records it.
  const onEscape = props.onEscape;
  useEffect(() => {
    if (state.escaped) onEscape();
  }, [state.escaped, onEscape]);

  // Done: measure and log so the 15 and 10 minute targets are checkable by hand.
  const finished = state.step === "done";
  useEffect(() => {
    if (!finished) return;
    const ms = elapsedMs(state, now());
    props.log(
      `[wizard] ${provider} completed in ${formatElapsed(ms)} (target ${targetMinutes(provider)}m)`,
    );
  }, [finished, provider, props.log, state, now]);

  const signIn = async () => {
    dispatch({ type: "signin.start" });
    try {
      const f = state.fields;
      const started = await api.oauth.start(provider, {
        clientId: f.clientId.trim(),
        ...(provider === "google" ? { clientSecret: f.clientSecret.trim() } : {}),
        ...(provider === "microsoft" ? { tenant: effectiveTenant(state) } : {}),
        pubsubTopic: provider === "google" && f.pubsubTopic.trim() ? f.pubsubTopic.trim() : null,
      });
      dispatch({ type: "signin.opened", state: started.state, url: started.url });
      await props.openExternal(started.url);
      for (;;) {
        const status = await api.oauth.status(provider, started.state);
        if (status.status === "done") {
          dispatch({ type: "signin.done", address: status.account.address, at: now() });
          props.onAdded?.(status.account);
          return;
        }
        if (status.status === "error") {
          dispatch({ type: "signin.failed", message: status.message });
          return;
        }
        await new Promise((r) => setTimeout(r, props.pollMs));
      }
    } catch (error) {
      dispatch({ type: "signin.failed", message: errorMessage(error) });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard in this webview; the text is selectable.
    }
  };

  const link = deepLink(state);
  const { n, total } = stepIndex(state);
  const title =
    provider === "google"
      ? s["strings.accounts.google.title"]
      : s["strings.accounts.microsoft.title"];

  return (
    <div className="wizard" data-step={state.step}>
      <div className="wizard-head">
        <h1>{title}</h1>
        {!finished ? (
          <span className="wizard-progress">
            {fill(s["strings.accounts.wizard.step_of"], { n, total })}
          </span>
        ) : null}
      </div>
      {!finished ? (
        <button
          type="button"
          className="wizard-escape"
          onClick={() => dispatch({ type: "escape" })}
        >
          {s["strings.accounts.wizard.escape"]}
        </button>
      ) : null}

      <div className="wizard-step">
        <p className="wizard-sentence">{sentenceFor(state, s)}</p>
        {link ? (
          <div className="wizard-action">
            <Btn primary onClick={() => void props.openExternal(link)}>
              <ArrowSquareOutIcon /> {actionFor(state, s)}
            </Btn>
          </div>
        ) : null}
        <StepBody
          state={state}
          strings={s}
          copied={copied}
          onField={(name, value) => dispatch({ type: "field", name, value })}
          onCopy={(text) => void copy(text)}
          onSignIn={() => void signIn()}
          onRetry={() => dispatch({ type: "signin.retry" })}
          now={now}
        />
      </div>

      <div className="wizard-foot">
        <div>
          {finished ? null : n === 1 ? (
            <Btn onClick={props.onBack}>{s["strings.accounts.wizard.back"]}</Btn>
          ) : (
            <Btn
              disabled={state.signIn.status === "waiting"}
              onClick={() => dispatch({ type: "back" })}
            >
              {s["strings.accounts.wizard.back"]}
            </Btn>
          )}
        </div>
        <div>
          {canSkip(state) ? (
            <Btn onClick={() => dispatch({ type: "skip" })}>
              {s["strings.accounts.wizard.skip"]}
            </Btn>
          ) : null}
          {finished ? (
            <Btn primary onClick={props.onDone}>
              {s["strings.accounts.wizard.done"]}
            </Btn>
          ) : state.step === "signin" ? null : (
            <Btn primary disabled={!canAdvance(state)} onClick={() => dispatch({ type: "next" })}>
              {s["strings.accounts.wizard.next"]}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

type Strings = ReturnType<typeof useShell>["settings"];

function sentenceFor(state: WizardState, s: Strings): string {
  if (state.provider === "google") {
    switch (state.step) {
      case "project":
        return s["strings.accounts.google.project"];
      case "api":
        return s["strings.accounts.google.api"];
      case "consent":
        return s["strings.accounts.google.consent"];
      case "client":
        return s["strings.accounts.google.client"];
      case "paste":
        return s["strings.accounts.google.paste"];
      case "pubsub":
        return s["strings.accounts.google.pubsub"];
      case "signin":
        return s["strings.accounts.google.signin"];
      default:
        return "";
    }
  }
  switch (state.step) {
    case "register":
      return s["strings.accounts.microsoft.register"];
    case "accountType":
      return s["strings.accounts.microsoft.account_type"];
    case "platform":
      return s["strings.accounts.microsoft.platform"];
    case "paste":
      return s["strings.accounts.microsoft.paste"];
    case "signin":
      return s["strings.accounts.microsoft.signin"];
    default:
      return "";
  }
}

function actionFor(state: WizardState, s: Strings): string {
  if (state.provider === "google") {
    switch (state.step) {
      case "project":
        return s["strings.accounts.google.project_action"];
      case "api":
        return s["strings.accounts.google.api_action"];
      case "consent":
        return s["strings.accounts.google.consent_action"];
      case "client":
        return s["strings.accounts.google.client_action"];
      case "pubsub":
        return s["strings.accounts.google.pubsub_action"];
      default:
        return "";
    }
  }
  switch (state.step) {
    case "register":
      return s["strings.accounts.microsoft.register_action"];
    case "platform":
      return s["strings.accounts.microsoft.platform_action"];
    default:
      return "";
  }
}

function StepBody({
  state,
  strings: s,
  copied,
  onField,
  onCopy,
  onSignIn,
  onRetry,
  now,
}: {
  state: WizardState;
  strings: Strings;
  copied: boolean;
  onField: (name: keyof WizardState["fields"], value: string) => void;
  onCopy: (text: string) => void;
  onSignIn: () => void;
  onRetry: () => void;
  now: () => number;
}) {
  const f = state.fields;
  const check = <ValidationLine state={state} strings={s} />;
  switch (state.step) {
    case "project":
      return (
        <div className="wizard-fields">
          <Field
            label={s["strings.accounts.google.project_id"]}
            help={s["strings.accounts.google.project_id_help"]}
          >
            <FieldInput
              value={f.projectId}
              onChange={(e) => onField("projectId", e.target.value)}
            />
          </Field>
        </div>
      );
    case "consent":
      return (
        <>
          <ConsentFigure />
          <div className="note">{s["strings.accounts.google.consent_note"]}</div>
        </>
      );
    case "paste":
      return (
        <div className="wizard-fields">
          <Field
            label={
              state.provider === "google"
                ? s["strings.accounts.google.client_id"]
                : s["strings.accounts.microsoft.client_id"]
            }
          >
            <FieldInput
              className={inputClass(state, "clientId")}
              value={f.clientId}
              onChange={(e) => onField("clientId", e.target.value)}
              spellCheck={false}
            />
          </Field>
          {state.provider === "google" ? (
            <Field label={s["strings.accounts.google.client_secret"]}>
              <FieldInput
                className={inputClass(state, "clientSecret")}
                type="password"
                value={f.clientSecret}
                onChange={(e) => onField("clientSecret", e.target.value)}
              />
            </Field>
          ) : f.accountType === "work" ? (
            <Field label={s["strings.accounts.microsoft.tenant"]}>
              <FieldInput
                className={inputClass(state, "tenant")}
                value={f.tenant}
                onChange={(e) => onField("tenant", e.target.value)}
                spellCheck={false}
              />
            </Field>
          ) : null}
          {check}
        </div>
      );
    case "pubsub": {
      const topic = f.pubsubTopic || suggestedTopic(state);
      return (
        <div className="wizard-fields">
          <Field label={s["strings.accounts.google.pubsub_principal"]}>
            <div className="wizard-copy">
              <code>{GMAIL_PUBLISHER}</code>
              <Btn onClick={() => onCopy(GMAIL_PUBLISHER)}>
                <CopyIcon />{" "}
                {copied ? s["strings.accounts.wizard.copied"] : s["strings.accounts.wizard.copy"]}
              </Btn>
            </div>
          </Field>
          <Field
            label={s["strings.accounts.google.pubsub_topic"]}
            help={s["strings.accounts.google.pubsub_note"]}
          >
            <FieldInput
              value={topic}
              placeholder="projects/your-project/topics/monday-gmail"
              onChange={(e) => onField("pubsubTopic", e.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
      );
    }
    case "accountType":
      return (
        <div className="mode">
          <button
            type="button"
            className={f.accountType === "personal" ? "on" : ""}
            aria-pressed={f.accountType === "personal"}
            onClick={() => onField("accountType", "personal")}
          >
            <b>{s["strings.accounts.microsoft.personal"]}</b>
          </button>
          <button
            type="button"
            className={f.accountType === "work" ? "on" : ""}
            aria-pressed={f.accountType === "work"}
            onClick={() => onField("accountType", "work")}
          >
            <b>{s["strings.accounts.microsoft.work"]}</b>
            <span>{s["strings.accounts.microsoft.consent_note"]}</span>
          </button>
        </div>
      );
    case "signin":
      return (
        <div className="wizard-fields">
          {state.signIn.status === "idle" || state.signIn.status === "error" ? (
            <div className="wizard-action">
              <Btn primary onClick={onSignIn}>
                {s["strings.accounts.wizard.signin"]}
              </Btn>
              {state.signIn.status === "error" ? (
                <Btn onClick={onRetry}>{s["strings.accounts.wizard.retry"]}</Btn>
              ) : null}
            </div>
          ) : null}
          {state.signIn.status === "error" ? (
            <div className="wizard-check bad">
              <WarningCircleIcon />{" "}
              {fill(s["strings.accounts.wizard.signin_failed"], { message: state.signIn.message })}
            </div>
          ) : null}
          {state.signIn.status === "starting" || state.signIn.status === "waiting" ? (
            <div className="wizard-check checking">
              <span className="live" /> {s["strings.accounts.wizard.signin_waiting"]}
            </div>
          ) : null}
        </div>
      );
    case "done":
      return (
        <div className="wizard-done">
          <b>
            <CheckCircleIcon />{" "}
            {fill(s["strings.accounts.wizard.signin_done"], {
              address: state.signIn.status === "done" ? state.signIn.address : "",
            })}
          </b>
          <span>
            {fill(s["strings.accounts.wizard.elapsed"], {
              time: formatElapsed(elapsedMs(state, now())),
            })}
          </span>
        </div>
      );
    default:
      return null;
  }
}

function inputClass(state: WizardState, field: string): string {
  const v = state.validation;
  if (v.status === "ok") return "ok";
  if (v.status === "error" && v.field === field) return "bad";
  return "";
}

function ValidationLine({ state, strings: s }: { state: WizardState; strings: Strings }) {
  const v = state.validation;
  if (v.status === "checking") {
    return (
      <div className="wizard-check checking" role="status">
        {s["strings.accounts.wizard.checking"]}
      </div>
    );
  }
  if (v.status === "ok") {
    return (
      <div className="wizard-check ok" role="status">
        <CheckCircleIcon /> {s["strings.accounts.wizard.valid"]}
        <Tag kind="ok">{v.detail}</Tag>
      </div>
    );
  }
  if (v.status === "error") {
    return (
      <div className="wizard-check bad" role="alert">
        <WarningCircleIcon /> {v.reason}
      </div>
    );
  }
  return <div className="wizard-check" />;
}

/** A sketch of Google's audience page with the two settings that matter. */
function ConsentFigure() {
  return (
    <div className="wizard-figure" aria-hidden="true">
      <div className="row">
        <span className="k">User type</span>
      </div>
      <div className="row">
        <span className="radio">
          <i /> Internal
        </span>
        <span className="radio on">
          <i /> External
        </span>
      </div>
      <div className="row">
        <span className="k">Publishing status</span>
        <span>In production</span>
      </div>
    </div>
  );
}
