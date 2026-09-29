// Connect a tool (docs/spec/settings.md "MCP servers"): search the MCP
// Registry through the Server, pick a card, and connect. A remote server that
// signs in with OAuth opens the browser (with Cancel while it is open, like the
// mail sign-in); one that wants a key, or a local package with declared
// inputs, asks for exactly those and nothing else. Once connected, the
// server's tools are listed and the user picks which ones Workflows and the
// Agent may use (all by default). Anything a tool does that leaves the
// mailbox still asks first (ADR 0002). Every word is a strings.mcp.* Setting.
//
// Keyboard: typing or "/" focuses the search, the arrows move between cards,
// Enter connects the focused card, Escape closes.

import type {
  McpCatalogEntry,
  McpDeclaredInput,
  McpServerStatus,
  McpServerView,
  McpToolView,
  Settings,
} from "@monday/shared";
import { Btn, Icon, Input, Seg, Select, Tag, useEscape, useFocusTrap } from "@monday/ui";
import {
  ArrowSquareOutIcon,
  CloudIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type Api,
  ApiError,
  type McpConnectBody,
  type McpConnectResponse,
} from "../../platform/api.ts";

type Strings = Pick<Settings, Extract<keyof Settings, `strings.mcp.${string}`>>;
type StringKey = keyof Strings & string;

/** "{name}" holes filled, the same way every other strings.* template is. */
export function fillIn(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

/** The Server's error body, read for the line under the form. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.message) as { message?: string; error?: string };
      return body.message ?? body.error ?? error.message;
    } catch {
      return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

const STATUS_KEY: Record<McpServerStatus, StringKey> = {
  connected: "strings.mcp.status.connected",
  needs_sign_in: "strings.mcp.status.needs_sign_in",
  needs_input: "strings.mcp.status.needs_input",
  error: "strings.mcp.status.error",
  unavailable: "strings.mcp.status.unavailable",
  unknown: "strings.mcp.status.unknown",
};

export function McpStatus({ status, s }: { status: McpServerStatus; s: Settings }) {
  const kind = status === "connected" ? "ok" : status === "unknown" ? undefined : "warn";
  return (
    <Tag kind={kind} className="mcp-status">
      <span data-status={status}>{s[STATUS_KEY[status]]}</span>
    </Tag>
  );
}

/* ------------------------------ Signing in ------------------------------ */

export type SignInState =
  | { phase: "idle" }
  | { phase: "waiting"; name: string; state: string; url: string }
  | { phase: "done"; name: string }
  | { phase: "failed"; name: string; message: string }
  | { phase: "cancelled"; name: string };

/**
 * The browser sign-in for one server at a time: the Server starts it and
 * hands back the authorization URL, the browser opens, and the status is
 * long-polled until it finishes. Cancel (or a new run) retires the poll and
 * tells the Server, so a late redirect adds nothing.
 */
export function useMcpSignIn(options: {
  api: Api;
  workspaceId: string;
  openExternal: (url: string) => Promise<void>;
  pollMs?: number | undefined;
}) {
  const { api, workspaceId, openExternal } = options;
  const pollMs = options.pollMs ?? 500;
  const run = useRef(0);
  const [state, setState] = useState<SignInState>({ phase: "idle" });
  const live = useRef(state);
  live.current = state;
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const start = useCallback(
    async (name: string): Promise<boolean> => {
      const mine = ++run.current;
      const alive = () => run.current === mine;
      try {
        const started = await api.mcp.signIn(workspaceId, name);
        if (!alive()) {
          void api.mcp.cancelSignIn(started.state).catch(() => {});
          return false;
        }
        setState({ phase: "waiting", name, state: started.state, url: started.url });
        await openExternal(started.url);
        for (;;) {
          if (!alive()) return false;
          const status = await api.mcp.signInStatus(started.state);
          if (!alive()) return false;
          if (status.status === "done") {
            setState({ phase: "done", name });
            return true;
          }
          if (status.status === "cancelled") {
            setState({ phase: "cancelled", name });
            return false;
          }
          if (status.status === "error") {
            setState({ phase: "failed", name, message: status.message });
            return false;
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } catch (error) {
        if (alive()) setState({ phase: "failed", name, message: errorText(error) });
        return false;
      }
    },
    [api, workspaceId, openExternal, pollMs],
  );

  const cancel = useCallback(() => {
    run.current += 1;
    const current = live.current;
    if (current.phase === "waiting") {
      void api.mcp.cancelSignIn(current.state).catch(() => {});
      setState({ phase: "cancelled", name: current.name });
    }
  }, [api]);

  const reopen = useCallback(() => {
    const current = live.current;
    if (current.phase === "waiting") void openExternal(current.url);
  }, [openExternal]);

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, start, cancel, reopen, reset };
}

/** The line and buttons shown while the browser is open. */
export function SignInWaiting({
  title,
  s,
  onCancel,
  onReopen,
}: {
  title: string;
  s: Settings;
  onCancel: () => void;
  onReopen: () => void;
}) {
  return (
    <div className="mcp-waiting" role="status" aria-live="polite">
      <p>{fillIn(s["strings.mcp.waiting"], { title })}</p>
      <div className="mcp-actions">
        <Btn sm onClick={onReopen}>
          <Icon icon={ArrowSquareOutIcon} /> {s["strings.mcp.open_again"]}
        </Btn>
        <Btn sm onClick={onCancel}>
          {s["strings.mcp.cancel"]}
        </Btn>
      </div>
    </div>
  );
}

/* ------------------------------ Choosing tools ------------------------------ */

/**
 * Each tool with a checkbox, all on by default. Saving writes the allowlist:
 * every tool on is stored as "every tool" ([]), so a tool the server adds later
 * is allowed too.
 */
export function ToolPicker({
  tools,
  s,
  busy,
  onSave,
  saveLabel,
}: {
  tools: McpToolView[];
  s: Settings;
  busy?: boolean | undefined;
  onSave: (allowlist: string[]) => void;
  saveLabel?: string | undefined;
}) {
  const [on, setOn] = useState<Set<string>>(
    () => new Set(tools.filter((t) => t.enabled).map((t) => t.name)),
  );
  useEffect(() => {
    setOn(new Set(tools.filter((t) => t.enabled).map((t) => t.name)));
  }, [tools]);
  const all = on.size === tools.length;
  if (tools.length === 0) return <p className="note">{s["strings.mcp.tools_none"]}</p>;
  return (
    <div className="mcp-tools">
      <div className="mcp-tools-head">
        <b>{s["strings.mcp.tools_title"]}</b>
        <label className="mcp-tool-all">
          <input
            type="checkbox"
            checked={all}
            onChange={() => setOn(all ? new Set() : new Set(tools.map((t) => t.name)))}
          />
          {s["strings.mcp.all"]}
        </label>
      </div>
      <ul>
        {tools.map((t) => (
          <li key={t.name} className="mcp-tool" data-tool={t.name}>
            <label>
              <input
                type="checkbox"
                checked={on.has(t.name)}
                onChange={() => {
                  const next = new Set(on);
                  if (next.has(t.name)) next.delete(t.name);
                  else next.add(t.name);
                  setOn(next);
                }}
              />
              <span>
                <b>{t.name}</b>
                {t.description ? <span>{t.description}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mcp-actions">
        <Btn
          primary
          sm
          disabled={busy || on.size === 0}
          onClick={() => onSave(all ? [] : tools.filter((t) => on.has(t.name)).map((t) => t.name))}
        >
          {saveLabel ?? s["strings.mcp.save_tools"]}
        </Btn>
      </div>
    </div>
  );
}

/* ------------------------------ The dialog ------------------------------ */

type Stage =
  | { kind: "search" }
  | { kind: "setup"; entry: McpCatalogEntry }
  | { kind: "url" }
  | { kind: "command" }
  | { kind: "signin"; server: McpServerView }
  | { kind: "tools"; server: McpServerView; tools: McpToolView[] };

export interface ConnectToolProps {
  api: Api;
  workspaceId: string;
  s: Settings;
  openExternal: (url: string) => Promise<void>;
  onClose: () => void;
  /** After a server is connected or its tools saved; the caller refreshes its list. */
  onConnected?: ((server: McpServerView) => void) | undefined;
  /** Whether the Server can start local servers (the Sidecar or a container). */
  canRunLocal?: boolean | undefined;
  pollMs?: number | undefined;
}

/** The values a card's inputs start with: each default, or empty. */
function initialValues(inputs: McpDeclaredInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((i) => [i.name, i.default ?? ""]));
}

const HOLE = /\{([A-Za-z0-9_.-]+)\}/g;
const holesOf = (t: string) => [...t.matchAll(HOLE)].map((m) => m[1] as string);

/**
 * What POST /mcp-servers gets for a registry card: its URL or command with
 * their templates, the values filled, which of those are secret, and no
 * header or variable whose optional input was left blank.
 */
export function connectBodyFor(
  entry: McpCatalogEntry,
  use: "remote" | "local",
  values: Record<string, string>,
): McpConnectBody {
  const inputs = (use === "remote" ? entry.remote?.inputs : entry.local?.inputs) ?? [];
  const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim().length > 0));
  const keep = (template: string) => holesOf(template).every((h) => h in given);
  const secret = inputs.filter((i) => i.secret && i.name in given).map((i) => i.name);
  const base = { name: entry.name, title: entry.title, registry: entry.id, values: given, secret };
  if (use === "remote" && entry.remote) {
    const headers = Object.fromEntries(
      Object.entries(entry.remote.headers).filter(([, t]) => keep(t)),
    );
    return {
      ...base,
      url: entry.remote.url,
      transport: entry.remote.transport,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const local = entry.local as NonNullable<McpCatalogEntry["local"]>;
  const env = Object.fromEntries(Object.entries(local.env).filter(([, t]) => keep(t)));
  return {
    ...base,
    command: local.command,
    args: local.args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** "NAME=value" lines into a map; anything else is ignored. */
function envLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").trim();
  }
  return out;
}

function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^(www|mcp|api)\./, "");
    return host.split(".")[0] ?? "server";
  } catch {
    return "";
  }
}

export function ConnectTool(props: ConnectToolProps) {
  const { api, workspaceId, s, onClose } = props;
  const canRunLocal = props.canRunLocal ?? true;
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "search" });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<McpCatalogEntry[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "busy" | "off" | "failed">("idle");
  /** Servers in the Server's copy of the registry while it is still downloading; null once complete. */
  const [catalogLoading, setCatalogLoading] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = useMcpSignIn({
    api,
    workspaceId,
    openExternal: props.openExternal,
    pollMs: props.pollMs,
  });
  const debounceMs = s["workflows.mcp_connect.debounce_ms"];
  const searchOn = s["workflows.mcp_registry.enabled"];

  useFocusTrap(ref);
  // Escape closes; a sign-in still open in the browser is cancelled first.
  useEscape(() => {
    signIn.cancel();
    onClose();
  });

  // Debounced live search; a newer query aborts the older request.
  useEffect(() => {
    if (!searchOn) {
      setSearchState("off");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchState("busy");
      try {
        const found = await api.mcp.search(query, controller.signal);
        if (controller.signal.aborted) return;
        setResults(found.entries);
        setCatalogLoading(found.catalog && !found.catalog.complete ? found.catalog.count : null);
        setSearchState(found.enabled ? "idle" : "off");
        setFocus(0);
      } catch {
        if (!controller.signal.aborted) setSearchState("failed");
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, debounceMs, searchOn]);

  useEffect(() => {
    if (stage.kind === "search") searchRef.current?.focus();
  }, [stage.kind]);

  const finish = useCallback(
    async (result: McpConnectResponse) => {
      props.onConnected?.(result.server);
      if (result.next === "sign_in") {
        setStage({ kind: "signin", server: result.server });
        const ok = await signIn.start(result.server.name);
        if (!ok) return;
        const listed = await api.mcp.tools(result.server.name);
        props.onConnected?.(listed.server);
        setStage({ kind: "tools", server: listed.server, tools: listed.tools });
        return;
      }
      if (result.next === "input") {
        setError(fillIn(s["strings.mcp.needs_key"], { title: result.server.title }));
        return;
      }
      setStage({ kind: "tools", server: result.server, tools: result.tools });
    },
    [api, props, s, signIn],
  );

  const connect = useCallback(
    async (body: McpConnectBody) => {
      setBusy(true);
      setError(null);
      try {
        await finish(await api.mcp.connect(workspaceId, body));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [api, workspaceId, finish],
  );

  /** A card with nothing to ask connects at once; otherwise its inputs come up. */
  const choose = useCallback(
    (entry: McpCatalogEntry) => {
      const use = entry.remote || !canRunLocal ? "remote" : "local";
      const inputs = (use === "remote" ? entry.remote?.inputs : entry.local?.inputs) ?? [];
      if (entry.remote && inputs.length === 0) {
        void connect({ ...connectBodyFor(entry, "remote", {}), replace: true });
        return;
      }
      setError(null);
      setStage({ kind: "setup", entry });
    },
    [canRunLocal, connect],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (stage.kind !== "search") return;
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "/" && !inField) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (!inField && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing anywhere in the dialog goes to the search.
      searchRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = results.length;
      if (n === 0) return;
      setFocus((f) => (e.key === "ArrowDown" ? (f + 1) % n : (f - 1 + n) % n));
      return;
    }
    if (e.key === "Enter" && (e.target === searchRef.current || !inField)) {
      const entry = results[focus];
      if (entry && !busy) {
        e.preventDefault();
        choose(entry);
      }
    }
  };

  const close = () => {
    signIn.cancel();
    onClose();
  };

  let body: React.ReactNode;
  if (stage.kind === "search") {
    body = (
      <>
        <div className="mcp-search">
          <Icon icon={MagnifyingGlassIcon} />
          <input
            ref={searchRef}
            value={query}
            placeholder={s["strings.mcp.search"]}
            aria-label={s["strings.mcp.search"]}
            spellCheck={false}
            disabled={!searchOn}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="mcp-results" role="listbox" aria-label={s["strings.mcp.results"]}>
          {searchState === "off" ? <p className="note">{s["strings.mcp.search_off"]}</p> : null}
          {catalogLoading !== null && searchState !== "off" ? (
            <p className="note" data-catalog="loading">
              {fillIn(s["strings.mcp.catalog_loading"], {
                count: catalogLoading.toLocaleString(),
              })}
            </p>
          ) : null}
          {searchState === "failed" ? (
            <p className="note">{s["strings.mcp.search_failed"]}</p>
          ) : null}
          {searchState === "busy" && results.length === 0 ? (
            <p className="note" aria-busy="true">
              {s["strings.mcp.searching"]}
            </p>
          ) : null}
          {searchState === "idle" && results.length === 0 && query.trim() ? (
            <p className="note">{fillIn(s["strings.mcp.no_results"], { query: query.trim() })}</p>
          ) : null}
          {results.map((entry, i) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              s={s}
              focused={i === focus}
              canRunLocal={canRunLocal}
              onHover={() => setFocus(i)}
              onChoose={() => choose(entry)}
            />
          ))}
        </div>
        <div className="mcp-foot">
          <Btn sm onClick={() => setStage({ kind: "url" })}>
            <Icon icon={GlobeIcon} /> {s["strings.mcp.add_url"]}
          </Btn>
          {canRunLocal ? (
            <Btn sm onClick={() => setStage({ kind: "command" })}>
              <Icon icon={TerminalWindowIcon} /> {s["strings.mcp.add_command"]}
            </Btn>
          ) : null}
          <span className="mcp-hint">{s["strings.mcp.hint"]}</span>
        </div>
      </>
    );
  } else if (stage.kind === "setup") {
    body = (
      <SetupForm
        entry={stage.entry}
        s={s}
        busy={busy}
        canRunLocal={canRunLocal}
        onBack={() => setStage({ kind: "search" })}
        onConnect={(use, values) =>
          void connect({ ...connectBodyFor(stage.entry, use, values), replace: true })
        }
      />
    );
  } else if (stage.kind === "url") {
    body = (
      <UrlForm
        s={s}
        busy={busy}
        onBack={() => setStage({ kind: "search" })}
        onConnect={(b) => void connect(b)}
      />
    );
  } else if (stage.kind === "command") {
    body = (
      <CommandForm
        s={s}
        busy={busy}
        onBack={() => setStage({ kind: "search" })}
        onConnect={(b) => void connect(b)}
      />
    );
  } else if (stage.kind === "signin") {
    const st = signIn.state;
    body = (
      <div className="mcp-stage">
        <h4>{stage.server.title}</h4>
        {st.phase === "waiting" ? (
          <SignInWaiting
            title={stage.server.title}
            s={s}
            onCancel={signIn.cancel}
            onReopen={signIn.reopen}
          />
        ) : st.phase === "cancelled" ? (
          <p className="note">{s["strings.mcp.cancelled"]}</p>
        ) : st.phase === "failed" ? (
          <p className="err" role="alert">
            {st.message}
          </p>
        ) : (
          <p className="note" aria-busy="true">
            {s["strings.mcp.connecting"]}
          </p>
        )}
        {st.phase === "cancelled" || st.phase === "failed" ? (
          <div className="mcp-actions">
            <Btn
              sm
              primary
              onClick={() => void finish({ server: stage.server, next: "sign_in", tools: [] })}
            >
              {s["strings.mcp.sign_in"]}
            </Btn>
            <Btn sm onClick={() => setStage({ kind: "search" })}>
              {s["strings.mcp.back"]}
            </Btn>
          </div>
        ) : null}
      </div>
    );
  } else {
    const server = stage.server;
    body = (
      <div className="mcp-stage">
        <h4>
          {server.title} <McpStatus status={server.status} s={s} />
        </h4>
        {server.message ? <p className="note">{server.message}</p> : null}
        <ToolPicker
          tools={stage.tools}
          s={s}
          busy={busy}
          saveLabel={s["strings.mcp.done"]}
          onSave={async (allowlist) => {
            setBusy(true);
            try {
              const same =
                allowlist.length === server.tools.length &&
                allowlist.every((t) => server.tools.includes(t));
              const saved = same ? server : await api.mcp.setTools(server.name, allowlist);
              props.onConnected?.(saved);
              onClose();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    );
  }

  return createPortal(
    <div className="mcp-scrim">
      <div
        ref={ref}
        className="mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={s["strings.mcp.title"]}
        onKeyDown={onKeyDown}
      >
        <header className="mcp-head">
          <Icon icon={PlugsConnectedIcon} />
          <div>
            <h3>{s["strings.mcp.title"]}</h3>
            <p>{s["strings.mcp.intro"]}</p>
          </div>
          <Btn icon aria-label={s["strings.mcp.close"]} onClick={close}>
            <Icon icon={XIcon} />
          </Btn>
        </header>
        {body}
        {error ? (
          <p className="err mcp-error" role="alert">
            {error}
          </p>
        ) : null}
        {busy && stage.kind !== "tools" ? (
          <p className="note mcp-busy" aria-busy="true">
            {s["strings.mcp.connecting"]}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function CatalogCard({
  entry,
  s,
  focused,
  canRunLocal,
  onHover,
  onChoose,
}: {
  entry: McpCatalogEntry;
  s: Settings;
  focused: boolean;
  canRunLocal: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  const inputs = entry.remote?.inputs ?? entry.local?.inputs ?? [];
  const needs = entry.remote
    ? inputs.length > 0
      ? s["strings.mcp.needs_inputs"]
      : s["strings.mcp.may_sign_in"]
    : inputs.length > 0
      ? s["strings.mcp.needs_inputs"]
      : null;
  const localOnly = !entry.remote && !canRunLocal;
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={focused}
      className={`mcp-card${focused ? " on" : ""}`}
      data-entry={entry.id}
      disabled={localOnly}
      onMouseEnter={onHover}
      onClick={onChoose}
    >
      <span className="mcp-card-icon">
        {entry.iconUrl ? (
          <img src={entry.iconUrl} alt="" width={20} height={20} />
        ) : (
          <Icon icon={entry.remote ? CloudIcon : TerminalWindowIcon} />
        )}
      </span>
      <span className="mcp-card-main">
        <span className="mcp-card-title">
          <b>{entry.title}</b>
          <span>{fillIn(s["strings.mcp.by"], { publisher: entry.publisher })}</span>
        </span>
        {entry.description ? <span className="mcp-card-desc">{entry.description}</span> : null}
        <span className="mcp-badges">
          {entry.remote ? <Tag>{s["strings.mcp.remote"]}</Tag> : null}
          {entry.local ? <Tag>{s["strings.mcp.local"]}</Tag> : null}
          {needs ? <Tag kind="ai">{needs}</Tag> : null}
          {localOnly ? <Tag kind="warn">{s["strings.mcp.status.unavailable"]}</Tag> : null}
        </span>
      </span>
    </button>
  );
}

function InputField({
  input,
  value,
  s,
  onChange,
}: {
  input: McpDeclaredInput;
  value: string;
  s: Settings;
  onChange: (v: string) => void;
}) {
  const id = `mcp-in-${input.name}`;
  return (
    <div className="mcp-field" data-input={input.name}>
      <label htmlFor={id}>
        {input.name}
        {input.required ? <em>{s["strings.mcp.required"]}</em> : null}
      </label>
      {input.choices.length > 0 ? (
        <Select
          id={id}
          className="wide"
          label={input.name}
          value={value}
          options={input.choices.map((c) => ({ value: c, label: c }))}
          onChange={onChange}
        />
      ) : (
        <Input
          id={id}
          type={input.secret ? "password" : "text"}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {input.description ? <span className="mcp-help">{input.description}</span> : null}
      {input.secret ? <span className="mcp-help">{s["strings.mcp.secret_note"]}</span> : null}
    </div>
  );
}

function SetupForm({
  entry,
  s,
  busy,
  canRunLocal,
  onBack,
  onConnect,
}: {
  entry: McpCatalogEntry;
  s: Settings;
  busy: boolean;
  canRunLocal: boolean;
  onBack: () => void;
  onConnect: (use: "remote" | "local", values: Record<string, string>) => void;
}) {
  const both = Boolean(entry.remote && entry.local && canRunLocal);
  const [use, setUse] = useState<"remote" | "local">(
    entry.remote || !canRunLocal ? "remote" : "local",
  );
  const inputs = useMemo(
    () => (use === "remote" ? entry.remote?.inputs : entry.local?.inputs) ?? [],
    [entry, use],
  );
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(inputs));
  useEffect(() => setValues(initialValues(inputs)), [inputs]);
  const missing = inputs.some((i) => i.required && !(values[i.name] ?? "").trim());
  const commandLine = entry.local ? [entry.local.command, ...entry.local.args].join(" ") : "";
  return (
    <form
      className="mcp-stage mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing && !busy) onConnect(use, values);
      }}
    >
      <h4>
        {entry.title}{" "}
        <span className="faint">{fillIn(s["strings.mcp.by"], { publisher: entry.publisher })}</span>
      </h4>
      {entry.description ? <p className="note">{entry.description}</p> : null}
      {both ? (
        <Seg
          options={[
            { value: "remote", label: s["strings.mcp.use_remote"] },
            { value: "local", label: s["strings.mcp.use_local"] },
          ]}
          value={use}
          onChange={(v) => setUse(v)}
        />
      ) : null}
      {use === "local" && entry.local ? (
        <p className="mcp-runs">
          <Icon icon={TerminalWindowIcon} />{" "}
          {fillIn(s["strings.mcp.runs"], { command: commandLine })}
        </p>
      ) : entry.remote ? (
        <p className="mcp-runs">
          <Icon icon={CloudIcon} /> {entry.remote.url}
        </p>
      ) : null}
      {inputs.length === 0 && use === "remote" ? (
        <p className="note">{fillIn(s["strings.mcp.sign_in_note"], { title: entry.title })}</p>
      ) : null}
      {inputs.map((input) => (
        <InputField
          key={`${input.kind}:${input.name}`}
          input={input}
          value={values[input.name] ?? ""}
          s={s}
          onChange={(v) => setValues({ ...values, [input.name]: v })}
        />
      ))}
      <div className="mcp-actions">
        <Btn primary sm type="submit" disabled={busy || missing}>
          {s["strings.mcp.connect_button"]}
        </Btn>
        <Btn sm onClick={onBack}>
          {s["strings.mcp.back"]}
        </Btn>
      </div>
    </form>
  );
}

function UrlForm({
  s,
  busy,
  onBack,
  onConnect,
}: {
  s: Settings;
  busy: boolean;
  onBack: () => void;
  onConnect: (body: McpConnectBody) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const valid = /^https?:\/\/\S+$/.test(url.trim());
  const shownName = name || nameFromUrl(url.trim());
  return (
    <form
      className="mcp-stage mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || busy || !shownName) return;
        onConnect({
          name: shownName,
          url: url.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
          replace: true,
        });
      }}
    >
      <h4>{s["strings.mcp.add_url"]}</h4>
      <div className="mcp-field">
        <label htmlFor="mcp-url">{s["strings.mcp.url"]}</label>
        <Input
          id="mcp-url"
          autoFocus
          value={url}
          spellCheck={false}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="mcp-field">
        <label htmlFor="mcp-name">{s["strings.mcp.name"]}</label>
        <Input
          id="mcp-name"
          value={shownName}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="mcp-field">
        <label htmlFor="mcp-token">{s["strings.mcp.token"]}</label>
        <Input
          id="mcp-token"
          type="password"
          value={token}
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
        />
        <span className="mcp-help">{s["strings.mcp.token_help"]}</span>
      </div>
      <div className="mcp-actions">
        <Btn primary sm type="submit" disabled={busy || !valid || !shownName}>
          {s["strings.mcp.connect_button"]}
        </Btn>
        <Btn sm onClick={onBack}>
          {s["strings.mcp.back"]}
        </Btn>
      </div>
    </form>
  );
}

function CommandForm({
  s,
  busy,
  onBack,
  onConnect,
}: {
  s: Settings;
  busy: boolean;
  onBack: () => void;
  onConnect: (body: McpConnectBody) => void;
}) {
  const [line, setLine] = useState("");
  const [name, setName] = useState("");
  const [env, setEnv] = useState("");
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const guess = (parts.find((p) => !p.startsWith("-") && p !== parts[0]) ?? parts[0] ?? "")
    .split("/")
    .pop()
    ?.replace(/@.*$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .toLowerCase();
  const shownName = name || guess || "";
  return (
    <form
      className="mcp-stage mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        const [command, ...args] = parts;
        if (!command || busy || !shownName) return;
        // Every environment value is sealed; the Setting keeps only the names.
        const values = envLines(env);
        const names = Object.keys(values);
        onConnect({
          name: shownName,
          command,
          args,
          ...(names.length > 0
            ? {
                env: Object.fromEntries(names.map((n) => [n, `{${n}}`])),
                values,
                secret: names,
              }
            : {}),
          replace: true,
        });
      }}
    >
      <h4>{s["strings.mcp.add_command"]}</h4>
      <div className="mcp-field">
        <label htmlFor="mcp-command">{s["strings.mcp.command"]}</label>
        <Input
          id="mcp-command"
          autoFocus
          value={line}
          spellCheck={false}
          placeholder="npx -y @scope/server"
          onChange={(e) => setLine(e.target.value)}
        />
        <span className="mcp-help">{s["strings.mcp.command_help"]}</span>
      </div>
      <div className="mcp-field">
        <label htmlFor="mcp-cmd-name">{s["strings.mcp.name"]}</label>
        <Input
          id="mcp-cmd-name"
          value={shownName}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="mcp-field">
        <label htmlFor="mcp-env">{s["strings.mcp.env"]}</label>
        <textarea
          id="mcp-env"
          className="input mcp-env"
          rows={3}
          value={env}
          spellCheck={false}
          placeholder="API_KEY=..."
          onChange={(e) => setEnv(e.target.value)}
        />
        <span className="mcp-help">{s["strings.mcp.secret_note"]}</span>
      </div>
      <div className="mcp-actions">
        <Btn primary sm type="submit" disabled={busy || parts.length === 0 || !shownName}>
          {s["strings.mcp.connect_button"]}
        </Btn>
        <Btn sm onClick={onBack}>
          {s["strings.mcp.back"]}
        </Btn>
      </div>
    </form>
  );
}

/* ------------------------------ The connected list ------------------------------ */

export interface McpServerListProps {
  api: Api;
  workspaceId: string;
  s: Settings;
  /** The servers as the Setting names them, for a first paint before the Server answers. */
  servers: ReadonlyArray<{
    name: string;
    title?: string | undefined;
    url?: string | undefined;
    command?: string | undefined;
    tools: string[];
  }>;
  openExternal: (url: string) => Promise<void>;
  /** After anything changes the Setting on the Server; the caller re-reads Settings. */
  onChanged: () => void;
  /** Rendered per row: the Settings screen's inline Remove with its question. */
  removeAction: (server: McpServerView, remove: () => Promise<void>) => React.ReactNode;
  pollMs?: number | undefined;
}

/**
 * Each connected server with its status, what it offers, Sign in or
 * Reconnect, the tools it may use, and Remove.
 */
export function McpServerList(props: McpServerListProps) {
  const { api, s } = props;
  const [views, setViews] = useState<McpServerView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolView[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signIn = useMcpSignIn({
    api,
    workspaceId: props.workspaceId,
    openExternal: props.openExternal,
    pollMs: props.pollMs,
  });
  const names = props.servers.map((x) => x.name).join("\n");

  const reload = useCallback(async () => {
    try {
      setViews(await api.mcp.list());
    } catch {
      setViews(null);
    }
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Setting's names are the trigger
  useEffect(() => {
    void reload();
  }, [reload, names]);

  const rows: McpServerView[] =
    views ??
    props.servers.map((x) => ({
      name: x.name,
      title: x.title ?? x.name,
      registry: null,
      kind: x.command ? "local" : "remote",
      target: x.url ?? x.command ?? "",
      auth: "none",
      secrets: [],
      tools: x.tools,
      status: "unknown",
      message: null,
    }));

  const update = (next: McpServerView) =>
    setViews((current) => (current ?? rows).map((v) => (v.name === next.name ? next : v)));

  const probe = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      const found = await api.mcp.tools(name);
      update(found.server);
      setTools((t) => ({ ...t, [name]: found.tools }));
      setOpen(name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const reconnect = async (server: McpServerView) => {
    if (server.auth === "oauth") {
      const ok = await signIn.start(server.name);
      if (ok) {
        await probe(server.name);
        props.onChanged();
      }
      return;
    }
    await probe(server.name);
  };

  if (rows.length === 0) return <div className="note">{s["strings.mcp.empty"]}</div>;
  return (
    <div className="mcp-list">
      {rows.map((server) => {
        const waiting = signIn.state.phase === "waiting" && signIn.state.name === server.name;
        const allowed =
          server.tools.length === 0
            ? s["strings.mcp.all_tools"]
            : fillIn(s["strings.mcp.some_tools"], { n: server.tools.length });
        return (
          <div className="mcp-server" key={server.name} data-mcp={server.name}>
            <div className="mcp-server-row">
              <span className="mcp-card-icon">
                <Icon icon={server.kind === "remote" ? CloudIcon : TerminalWindowIcon} />
              </span>
              <span className="record-key">
                <b>{server.title}</b>
                <span>
                  {server.target} · {allowed}
                </span>
              </span>
              <McpStatus status={server.status} s={s} />
              <span className="mcp-row-actions">
                <Btn sm disabled={busy === server.name} onClick={() => void probe(server.name)}>
                  {s["strings.mcp.tools"]}
                </Btn>
                {server.status !== "unavailable" ? (
                  <Btn
                    sm
                    disabled={busy === server.name || waiting}
                    onClick={() => void reconnect(server)}
                  >
                    {server.auth === "oauth" && server.status === "needs_sign_in"
                      ? s["strings.mcp.sign_in"]
                      : s["strings.mcp.reconnect"]}
                  </Btn>
                ) : null}
                {props.removeAction(server, async () => {
                  await api.mcp.remove(server.name);
                  setViews((current) => (current ?? rows).filter((v) => v.name !== server.name));
                  props.onChanged();
                })}
              </span>
            </div>
            {server.message && server.status !== "connected" ? (
              <p className="note mcp-message">{server.message}</p>
            ) : null}
            {waiting ? (
              <SignInWaiting
                title={server.title}
                s={s}
                onCancel={signIn.cancel}
                onReopen={signIn.reopen}
              />
            ) : null}
            {signIn.state.phase === "failed" && signIn.state.name === server.name ? (
              <p className="err" role="alert">
                {signIn.state.message}
              </p>
            ) : null}
            {signIn.state.phase === "cancelled" && signIn.state.name === server.name ? (
              <p className="note">{s["strings.mcp.cancelled"]}</p>
            ) : null}
            {open === server.name && tools[server.name] ? (
              <ToolPicker
                tools={tools[server.name] ?? []}
                s={s}
                busy={busy === server.name}
                onSave={async (allowlist) => {
                  setBusy(server.name);
                  try {
                    update(await api.mcp.setTools(server.name, allowlist));
                    setOpen(null);
                    props.onChanged();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            ) : null}
          </div>
        );
      })}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
