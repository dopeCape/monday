// The process seam under the Local runtime adapters (CONTEXT.md, Local
// runtime): a command spawned on the Device with lines in and lines out. The
// Tauri shell plugin implements it in the app; the fake here replays a
// recorded transcript of a CLI's real stream format, line by line, with the
// turns keyed to what the adapter writes on stdin, so an adapter is tested
// against the exact bytes its CLI produces without the CLI installed.

export interface SpawnOptions {
  args: readonly string[];
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  /** A directory to search first for the command: the Setting's path override. */
  pathPrefix?: string | undefined;
}

/** A running process: its output as lines, its stdin, and its end. */
export interface Process {
  readonly pid: number | null;
  onStdout(listener: (line: string) => void): () => void;
  onStderr(listener: (line: string) => void): () => void;
  /** Resolves with the exit code, or null when killed by a signal. */
  readonly exited: Promise<number | null>;
  write(text: string): Promise<void>;
  kill(): Promise<void>;
}

export type ProcessRunner = (command: string, options: SpawnOptions) => Promise<Process>;

/** Runs a command to completion; the detection path. */
export async function runToEnd(
  runner: ProcessRunner,
  command: string,
  args: readonly string[],
  options: {
    env?: Record<string, string> | undefined;
    pathPrefix?: string | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; failed: string | null }> {
  let process: Process;
  try {
    process = await runner(command, {
      args,
      ...(options.env ? { env: options.env } : {}),
      ...(options.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
    });
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      failed: error instanceof Error ? error.message : String(error),
    };
  }
  const out: string[] = [];
  const err: string[] = [];
  process.onStdout((l) => out.push(l));
  process.onStderr((l) => err.push(l));
  const timeout = options.timeoutMs ?? 10_000;
  const code = await Promise.race([
    process.exited,
    new Promise<null>((resolve) =>
      setTimeout(() => {
        void process.kill();
        resolve(null);
      }, timeout),
    ),
  ]);
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), failed: null };
}

/* ------------------------------ Fake ------------------------------ */

/**
 * What the fake process does with a line the adapter wrote to stdin: the
 * lines to emit on stdout, in order, possibly produced asynchronously (a
 * recorded tool call that runs for real first).
 */
export type FakeReply = (input: string) => AsyncIterable<string> | Iterable<string>;

export interface FakeProcessScript {
  /** Lines emitted right after spawn, before any input (a CLI's init line). */
  greeting?: readonly string[] | undefined;
  /** Answers each stdin line in turn; past the script the process stays silent. */
  replies?: readonly FakeReply[] | undefined;
  /** Lines on stderr right after spawn. */
  stderr?: readonly string[] | undefined;
  /** The exit code the process ends with when killed or when its stdin closes. */
  exitCode?: number | undefined;
  /** Fails the spawn itself, as a missing binary would. */
  spawnError?: string | undefined;
}

export interface FakeProcess extends Process {
  /** Every line the adapter wrote, in order. */
  written: string[];
  killed: boolean;
  /** Emits lines as if the process printed them. */
  emit(...lines: string[]): void;
  /** Ends the process with a code. */
  exit(code: number | null): void;
}

export interface FakeRunner {
  runner: ProcessRunner;
  /** Every spawn, in order, with its command and options. */
  spawns: Array<{ command: string; options: SpawnOptions; process: FakeProcess }>;
}

/** A runner whose processes follow one script per command name (a missing command fails to spawn). */
export function fakeProcessRunner(scripts: Record<string, FakeProcessScript>): FakeRunner {
  const spawns: FakeRunner["spawns"] = [];
  const runner: ProcessRunner = async (command, options) => {
    const script = scripts[command];
    if (!script) throw new Error(`${command}: command not found`);
    if (script.spawnError) throw new Error(script.spawnError);
    const process = fakeProcess(script);
    spawns.push({ command, options, process });
    return process;
  };
  return { runner, spawns };
}

export function fakeProcess(script: FakeProcessScript): FakeProcess {
  const stdout = new Set<(line: string) => void>();
  const stderr = new Set<(line: string) => void>();
  const written: string[] = [];
  const replies = [...(script.replies ?? [])];
  let ended = false;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  // Output before anyone listens waits, as bytes in a pipe would.
  const pendingOut: string[] = [];
  const pendingErr: string[] = [];
  const emit = (...lines: string[]) => {
    for (const line of lines) {
      if (stdout.size === 0) pendingOut.push(line);
      else for (const l of stdout) l(line);
    }
  };
  const process: FakeProcess = {
    pid: 4242,
    written,
    killed: false,
    exited,
    emit,
    exit(code) {
      if (ended) return;
      ended = true;
      resolveExit(code);
    },
    onStdout(listener) {
      stdout.add(listener);
      for (const line of pendingOut.splice(0)) listener(line);
      return () => stdout.delete(listener);
    },
    onStderr(listener) {
      stderr.add(listener);
      for (const line of pendingErr.splice(0)) listener(line);
      return () => stderr.delete(listener);
    },
    async write(text) {
      for (const line of text.split("\n")) {
        if (!line) continue;
        written.push(line);
        const reply = replies.shift();
        if (!reply) continue;
        // Answer on the next tick, as a real process would: never inside the caller's await.
        void (async () => {
          await Promise.resolve();
          for await (const out of reply(line)) emit(out);
        })();
      }
    },
    async kill() {
      process.killed = true;
      process.exit(script.exitCode ?? null);
    },
  };
  for (const line of script.stderr ?? []) {
    if (stderr.size === 0) pendingErr.push(line);
    else for (const l of stderr) l(line);
  }
  emit(...(script.greeting ?? []));
  return process;
}
