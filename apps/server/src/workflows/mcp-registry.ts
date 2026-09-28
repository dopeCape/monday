// The MCP Registry as the Connect surface searches it (docs/research/mcp-connect.md,
// docs/spec/settings.md "MCP servers"). The Server asks the registry, never the
// desktop app, so the client needs no network rules of its own and one short
// cache serves every Device. The registry is in preview and asks host apps not
// to lean on it, so its address is a Setting (a company subregistry speaks the
// same API) and a failure reads as "search is unavailable", never a crash.
//
//   GET {base}/servers?search=&limit=&version=latest
//   -> {servers: [{server: server.json, _meta}], metadata: {nextCursor, count}}

import type { McpCatalogEntry, McpDeclaredInput } from "@monday/shared";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpRegistrySettings {
  enabled: boolean;
  /** The base URL up to its version path, "https://registry.modelcontextprotocol.io/v0.1". */
  url: string;
  results: number;
  cacheMinutes: number;
}

export interface McpRegistry {
  /** Servers whose name matches `query`, newest version only, at most `limit`. */
  search(query: string, limit?: number): Promise<McpCatalogEntry[]>;
  /** One entry by its registry id, or null when the registry does not know it. */
  get(id: string): Promise<McpCatalogEntry | null>;
}

export class McpRegistryOffError extends Error {
  constructor() {
    super("searching the MCP Registry is switched off");
    this.name = "McpRegistryOffError";
  }
}

export class McpRegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRegistryUnavailableError";
  }
}

export interface McpRegistryOptions {
  settings: () => Promise<McpRegistrySettings>;
  fetch?: FetchLike;
  now?: () => number;
}

export function createMcpRegistry(options: McpRegistryOptions): McpRegistry {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; value: unknown }>();

  const getJson = async (url: string, ttlMs: number): Promise<unknown> => {
    const hit = cache.get(url);
    if (hit && ttlMs > 0 && now() - hit.at < ttlMs) return hit.value;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new McpRegistryUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new McpRegistryUnavailableError(`the registry answered ${res.status}`);
    const value = (await res.json()) as unknown;
    if (ttlMs > 0) {
      cache.set(url, { at: now(), value });
      // Bounded: a long session of typing never grows it past a few hundred answers.
      if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    }
    return value;
  };

  const base = (url: string) => url.replace(/\/+$/, "");

  return {
    async search(query, limit) {
      const s = await options.settings();
      if (!s.enabled) throw new McpRegistryOffError();
      const n = Math.max(1, Math.min(100, limit ?? s.results));
      const params = new URLSearchParams({ version: "latest", limit: String(n) });
      if (query.trim()) params.set("search", query.trim());
      const body = await getJson(`${base(s.url)}/servers?${params}`, s.cacheMinutes * 60_000);
      const rows = (body as { servers?: unknown[] } | null)?.servers ?? [];
      const out: McpCatalogEntry[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const entry = catalogEntryOf(row);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
      }
      return out.slice(0, n);
    },
    async get(id) {
      const s = await options.settings();
      if (!s.enabled) throw new McpRegistryOffError();
      const body = await getJson(
        `${base(s.url)}/servers/${encodeURIComponent(id)}/versions/latest`,
        s.cacheMinutes * 60_000,
      );
      return body ? catalogEntryOf(body) : null;
    },
  };
}

/* ------------------------------ server.json to a card ------------------------------ */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "io.github.owner/some-server" -> "some-server"; safe as a Setting name. */
export function shortNameOf(id: string): string {
  const tail = id.split("/").pop() ?? id;
  const clean = tail
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (clean || "server").slice(0, 60);
}

/** "io.github.owner/x" -> "owner"; "com.example/x" -> "example.com". */
export function publisherOf(id: string): string {
  const ns = id.split("/")[0] ?? id;
  const parts = ns.split(".");
  if (parts[0] === "io" && parts[1] === "github" && parts[2]) return parts.slice(2).join(".");
  return parts.reverse().join(".");
}

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

/** The `{names}` a template holds, in order, without repeats. */
export function placeholdersOf(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Fills `{name}` from `values`; an unknown name stays as written. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

function inputOf(
  kind: McpDeclaredInput["kind"],
  name: string,
  raw: Json,
  inherit?: { secret: boolean },
): McpDeclaredInput {
  return {
    kind,
    name,
    description: str(raw.description) ?? "",
    required: raw.isRequired === true || kind === "variable",
    secret: raw.isSecret === true || inherit?.secret === true,
    default: str(raw.default),
    choices: arr(raw.choices).filter((c): c is string => typeof c === "string"),
  };
}

/** The variables a templated value declares, as inputs; a value with none is fixed. */
function variableInputs(raw: Json, parentSecret: boolean): McpDeclaredInput[] {
  const vars = obj(raw.variables) ?? {};
  const value = str(raw.value) ?? "";
  return placeholdersOf(value).map((name) =>
    inputOf("variable", name, obj(vars[name]) ?? {}, { secret: parentSecret }),
  );
}

/**
 * The inputs and the value template a key-value input (a header or an
 * environment variable) stands for: a fixed `value` asks nothing, a
 * templated one asks its variables, no value asks for the value itself.
 */
function keyValue(
  kind: "env" | "header",
  raw: Json,
): { name: string; template: string; inputs: McpDeclaredInput[] } | null {
  const name = str(raw.name);
  if (!name) return null;
  const value = str(raw.value);
  if (value !== null) {
    return { name, template: value, inputs: variableInputs(raw, raw.isSecret === true) };
  }
  return { name, template: `{${name}}`, inputs: [inputOf(kind, name, raw)] };
}

/** An argument list entry: `--flag value`, a positional value, with `{variables}` kept as templates. */
function argsOf(list: unknown[], inputs: McpDeclaredInput[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const a = obj(item);
    if (!a) continue;
    const value = str(a.value) ?? str(a.default);
    if (a.type === "named") {
      const flag = str(a.name);
      if (!flag) continue;
      if (value !== null) {
        out.push(flag, value);
        inputs.push(...variableInputs(a, a.isSecret === true));
      } else if (a.isRequired === true) {
        // A required flag with no value: the user supplies it as a variable named after the flag.
        const name = flag.replace(/^-+/, "");
        out.push(flag, `{${name}}`);
        inputs.push(inputOf("variable", name, a));
      }
    } else if (value !== null) {
      out.push(value);
      inputs.push(...variableInputs(a, a.isSecret === true));
    } else if (a.isRequired === true) {
      const name = str(a.valueHint) ?? "value";
      out.push(`{${name}}`);
      inputs.push(inputOf("variable", name, a));
    }
  }
  return out;
}

const RUNNERS: Record<
  string,
  { command: string; args: (pkg: string, version: string) => string[] }
> = {
  npm: { command: "npx", args: (p, v) => ["-y", v ? `${p}@${v}` : p] },
  pypi: { command: "uvx", args: (p, v) => [v ? `${p}==${v}` : p] },
  oci: { command: "docker", args: (p) => ["run", "-i", "--rm", p] },
  nuget: { command: "dnx", args: (p, v) => [v ? `${p}@${v}` : p, "--yes"] },
};

function dedupe(inputs: McpDeclaredInput[]): McpDeclaredInput[] {
  const seen = new Set<string>();
  return inputs.filter((i) => {
    const key = `${i.kind}:${i.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The command line and inputs a stdio package runs with, or null for one monday cannot start. */
function localOf(pkg: Json): McpCatalogEntry["local"] {
  const transport = obj(pkg.transport);
  if (transport && transport.type !== "stdio") return null;
  const registryType = str(pkg.registryType) ?? "";
  const identifier = str(pkg.identifier);
  if (!identifier) return null;
  const version = str(pkg.version) ?? "";
  const runner = RUNNERS[registryType];
  const hint = str(pkg.runtimeHint);
  if (!runner && !hint) return null;
  const inputs: McpDeclaredInput[] = [];
  const runtimeArgs = argsOf(arr(pkg.runtimeArguments), inputs);
  const packageArgs = argsOf(arr(pkg.packageArguments), inputs);
  const env: Record<string, string> = {};
  for (const raw of arr(pkg.environmentVariables)) {
    const kv = obj(raw) ? keyValue("env", obj(raw) as Json) : null;
    if (!kv) continue;
    inputs.push(...kv.inputs);
    env[kv.name] = kv.template;
  }
  let command: string;
  let args: string[];
  if (registryType === "oci") {
    // Docker needs each variable passed through with -e before the image.
    command = hint ?? "docker";
    const envFlags = Object.keys(env).flatMap((name) => ["-e", name]);
    args = ["run", "-i", "--rm", ...envFlags, ...runtimeArgs, identifier, ...packageArgs];
  } else {
    command = hint ?? runner?.command ?? "npx";
    const base = runner ? runner.args(identifier, version) : [identifier];
    args = [...runtimeArgs, ...base, ...packageArgs];
  }
  return { registryType, identifier, version, command, args, env, inputs: dedupe(inputs) };
}

/** The hosted endpoint and its inputs, or null for none. Streamable HTTP wins over SSE. */
function remoteOf(remotes: unknown[]): McpCatalogEntry["remote"] {
  const all = remotes.map(obj).filter((r): r is Json => r !== null && str(r.url) !== null);
  const pick = all.find((r) => r.type === "streamable-http") ?? all.find((r) => r.type === "sse");
  if (!pick) return null;
  const url = str(pick.url) as string;
  const inputs: McpDeclaredInput[] = [];
  const headers: Record<string, string> = {};
  const vars = obj(pick.variables) ?? {};
  for (const name of placeholdersOf(url)) {
    inputs.push(inputOf("variable", name, obj(vars[name]) ?? {}));
  }
  for (const raw of arr(pick.headers)) {
    const h = obj(raw);
    const kv = h ? keyValue("header", h) : null;
    if (!kv) continue;
    inputs.push(...kv.inputs);
    headers[kv.name] = kv.template;
  }
  return {
    url,
    transport: pick.type === "sse" ? "sse" : "streamable-http",
    headers,
    inputs: dedupe(inputs),
  };
}

/** One registry row (`{server, _meta}` or a bare server.json) as a card; null when it is unusable or deleted. */
export function catalogEntryOf(row: unknown): McpCatalogEntry | null {
  const r = obj(row);
  if (!r) return null;
  const server = obj(r.server) ?? r;
  const meta = obj(obj(r._meta)?.["io.modelcontextprotocol.registry/official"]);
  if (meta?.status === "deleted") return null;
  const id = str(server.name);
  if (!id) return null;
  const remote = remoteOf(arr(server.remotes));
  const local =
    arr(server.packages)
      .map(obj)
      .filter((p): p is Json => p !== null)
      .map(localOf)
      .find((l) => l !== null) ?? null;
  if (!remote && !local) return null;
  const icon = arr(server.icons)
    .map(obj)
    .find((i) => str(i?.src)?.startsWith("https://"));
  return {
    id,
    name: shortNameOf(id),
    title: str(server.title) ?? shortNameOf(id),
    publisher: publisherOf(id),
    description: str(server.description) ?? "",
    version: str(server.version) ?? "",
    websiteUrl: str(server.websiteUrl) ?? str(obj(server.repository)?.url),
    iconUrl: icon ? (str(icon.src) as string) : null,
    remote,
    local,
  };
}
