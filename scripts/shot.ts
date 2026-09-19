// Headless screenshot check for the desktop Inbox against the design mock.
//
//   bun scripts/shot.ts                 compare the app against the checked-in baselines
//   bun scripts/shot.ts --update        re-capture the baselines from design/ (needs review)
//   bun scripts/shot.ts --only routing  one state (with --update, re-capture only that baseline)
//
// Starts its own design server and Vite dev server on spare ports, renders each
// state in headless Chrome at 1440x900, and pixel-diffs it against the mock's
// equivalent in apps/desktop/test/baselines/. Diff images land in
// apps/desktop/test/diffs/ (gitignored). Fails above SHOT_TOLERANCE (2%).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const root = new URL("../", import.meta.url).pathname;
const baselines = join(root, "apps/desktop/test/baselines");
const diffs = join(root, "apps/desktop/test/diffs");
const chrome = process.env.CHROME ?? "google-chrome";
const tolerance = Number(process.env.SHOT_TOLERANCE ?? "2");
const designPort = Number(process.env.SHOT_DESIGN_PORT ?? "6979");
const appPort = Number(process.env.SHOT_APP_PORT ?? "1479");
const update = process.argv.includes("--update");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
const size = { width: 1440, height: 900 };

/** Each state: the app URL and the mock's equivalent. */
const states: Array<{ name: string; app: string; mock: string }> = [
  { name: "inbox", app: "/", mock: "/app.html?chrome=0" },
  { name: "inbox-open", app: "/?sel=e1", mock: "/app.html?chrome=0&sel=e1" },
  // The mock has no multi-select; its equivalent is the inbox with the first row on.
  { name: "inbox-multi", app: "/?multi=e1,e2,e3", mock: "/app.html?chrome=0" },
  { name: "palette", app: "/?overlay=cmdk", mock: "/app.html?chrome=0&overlay=cmdk" },
  // Slice 8: the reader over a real body (the fixture Cache in the dev server) and compose.
  { name: "reader-body", app: "/?sel=e2", mock: "/app.html?chrome=0&sel=e2" },
  { name: "compose", app: "/?compose=d1", mock: "/app.html?chrome=0&overlay=compose" },
  // Slice 12: the Routing page over the fixture Groups and the Needs a decision queue.
  { name: "routing", app: "/?screen=routing", mock: "/app.html?chrome=0#/routing" },
  // Slice 16: the Workflows page over the fixture documents and Runs.
  { name: "workflows", app: "/?screen=workflows", mock: "/app.html?chrome=0#/workflows" },
];

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function shoot(url: string, out: string): Promise<void> {
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${size.width},${size.height}`,
      "--virtual-time-budget=4000",
      `--screenshot=${out}`,
      url,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${chrome} exited ${code} for ${url}`);
}

function compare(name: string, actualPath: string, expectedPath: string): number {
  const a = PNG.sync.read(readFileSync(actualPath));
  const b = PNG.sync.read(readFileSync(expectedPath));
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${name}: size ${a.width}x${a.height} vs baseline ${b.width}x${b.height}`);
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  writeFileSync(join(diffs, `${name}.diff.png`), PNG.sync.write(diff));
  return (100 * differing) / (a.width * a.height);
}

async function main(): Promise<number> {
  mkdirSync(baselines, { recursive: true });
  mkdirSync(diffs, { recursive: true });

  const design = Bun.spawn(["bun", join(root, "design/serve.ts")], {
    env: { ...process.env, PORT: String(designPort) },
    stdout: "ignore",
    stderr: "ignore",
  });
  const app = Bun.spawn(["bunx", "vite", "--port", String(appPort), "--strictPort"], {
    cwd: join(root, "apps/desktop"),
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitFor(`http://localhost:${designPort}/app.html`);
    await waitFor(`http://localhost:${appPort}/`);
    // Vite's first request compiles; render once so timings settle.
    await shoot(`http://localhost:${appPort}/`, join(diffs, "warmup.png"));

    let failed = 0;
    for (const s of states) {
      if (only && s.name !== only) continue;
      const expected = join(baselines, `${s.name}.png`);
      const actual = join(diffs, `${s.name}.actual.png`);
      if (update) await shoot(`http://localhost:${designPort}${s.mock}`, expected);
      await shoot(`http://localhost:${appPort}${s.app}`, actual);
      const pct = compare(s.name, actual, expected);
      const ok = pct <= tolerance;
      if (!ok) failed++;
      console.log(`${ok ? "ok  " : "FAIL"} ${s.name.padEnd(14)} ${pct.toFixed(2)}% differing`);
    }
    return failed;
  } finally {
    design.kill();
    app.kill();
  }
}

const failed = await main();
if (failed > 0) {
  console.error(`${failed} screenshot(s) differ by more than ${tolerance}%`);
  process.exit(1);
}
