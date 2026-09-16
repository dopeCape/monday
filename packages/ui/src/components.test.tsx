/// <reference types="bun-types" />
// Smoke tests: every component renders with fixture props through
// react-dom/server, the markup carries the mock's classes, and nothing
// user-facing contains an em-dash.
import { describe, expect, test } from "bun:test";
import { MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import * as fx from "./fixtures.ts";
import {
  AgentBar,
  AgentColumn,
  AgentDock,
  AgentPanel,
  AgentThread,
  Attachment,
  Avatar,
  Brief,
  Btn,
  Chip,
  ColHead,
  CommandPalette,
  Compose,
  CustomSwatch,
  FlowChain,
  FlowEdge,
  FlowNode,
  Icon,
  Input,
  Kbd,
  Mark,
  Message,
  MessageRow,
  NavSidebar,
  palettes,
  Rail,
  ReplyBox,
  ResultsList,
  Scrim,
  SectionLabel,
  Seg,
  SettingsField,
  Swatch,
  Switch,
  Tabs,
  Tag,
  ThemeProvider,
  ToolCard,
  useTheme,
  Vr,
} from "./index.ts";

const EM_DASH = String.fromCharCode(0x2014);
const rendered: string[] = [];

function render(node: ReactNode): string {
  const html = renderToString(node);
  rendered.push(html);
  return html;
}

const e1 = fx.threadById("e1");
const e4 = fx.threadById("e4");
if (!e1 || !e4) throw new Error("fixtures missing e1 or e4");
const brief1 = fx.briefOf("e1");
if (!brief1) throw new Error("fixture brief for e1 missing");
const [m1a, , m1c] = fx.messagesOf("e1");
if (!m1a || !m1c) throw new Error("fixture messages for e1 missing");
const firstAttachment = m1c.attachments[0];
if (!firstAttachment) throw new Error("fixture attachment missing");
const palette = palettes[0];
if (!palette) throw new Error("no palettes");

describe("primitives", () => {
  test("Avatar shows initials and a color custom property", () => {
    const html = render(<Avatar name="Aoife Brennan" />);
    expect(html).toContain('class="avatar"');
    expect(html).toContain(">AB<");
    expect(html).toContain("--c:");
  });

  test("Avatar takes explicit initials, square and live", () => {
    const html = render(<Avatar name="GenAI Labs" initials="GL" square live color="var(--fg)" />);
    expect(html).toContain("avatar sq");
    expect(html).toContain("GL");
    expect(html).toContain('class="live"');
  });

  test("Mark is the monogram", () => {
    expect(render(<Mark />)).toContain('class="mk"');
    expect(render(<Mark small />)).toContain('class="mk sm"');
  });

  test("Btn variants map to classes", () => {
    expect(render(<Btn>Go</Btn>)).toContain('class="btn"');
    expect(render(<Btn icon title="x" />)).toContain('class="btn icon"');
    expect(
      render(
        <Btn sm primary>
          Send
        </Btn>,
      ),
    ).toContain('class="btn sm primary"');
    expect(render(<Btn outline>Add</Btn>)).toContain('class="btn outline"');
    expect(render(<Btn on>On</Btn>)).toContain('class="btn on"');
  });

  test("Chip, Tag, Kbd, Input, Vr", () => {
    expect(render(<Chip on>Filter</Chip>)).toContain('class="chip on"');
    expect(render(<Tag kind="ok">Connected</Tag>)).toContain('class="tag ok"');
    expect(render(<Tag kind="warn">Needs reply</Tag>)).toContain('class="tag warn"');
    expect(render(<Kbd>⌘K</Kbd>)).toContain('class="kbd"');
    expect(render(<Input placeholder="Name" />)).toContain('class="input"');
    expect(render(<Vr />)).toContain('class="vr"');
  });

  test("Switch reflects its state", () => {
    expect(render(<Switch on label="Ask before sending" />)).toContain('class="switch on"');
    const off = render(<Switch on={false} />);
    expect(off).toContain('class="switch"');
    expect(off).toContain('aria-checked="false"');
  });

  test("Seg marks the active option and draws icons", () => {
    const html = render(
      <Seg
        value="dark"
        options={[
          { value: "system", label: "System", icon: MonitorIcon },
          { value: "light", label: "Light", icon: SunIcon },
          { value: "dark", label: "Dark", icon: MoonIcon },
        ]}
      />,
    );
    expect(html).toContain('class="seg"');
    expect(html).toContain('class="on"');
    expect(html).toContain("<svg");
  });

  test("Tabs show counts", () => {
    const html = render(
      <Tabs
        active="active"
        items={[
          { key: "active", label: "Active", count: 3 },
          { key: "paused", label: "Paused", count: 1 },
        ]}
      />,
    );
    expect(html).toContain('class="tabs"');
    expect(html).toContain('<span class="n">3</span>');
  });

  test("ColHead and SectionLabel", () => {
    const html = render(
      <ColHead title="Inbox" count={14}>
        <Btn>Filter</Btn>
      </ColHead>,
    );
    expect(html).toContain("<h2>Inbox</h2>");
    expect(html).toContain('class="count">14<');
    expect(render(<SectionLabel>Needs your reply</SectionLabel>)).toContain(
      '<div class="sec">Needs your reply</div>',
    );
  });

  test("Icon wraps a Phosphor SVG in the ph class", () => {
    expect(render(<Icon icon={SunIcon} />)).toContain('<i class="ph"');
    expect(render(<Icon icon={SunIcon} weight="fill" />)).toContain('<i class="ph-fill"');
  });
});

describe("navigation", () => {
  test("NavSidebar lists folders, Groups with Sub-groups, automation and settings", () => {
    const html = render(
      <NavSidebar
        workspace={fx.navWorkspace}
        folders={fx.folders}
        calendar={fx.calendarNav}
        groups={fx.groups}
        counts={fx.counts}
        groupIcon={fx.groupIcon}
        automation={fx.automationNav}
        active="inbox"
      />,
    );
    expect(html).toContain('class="nav"');
    expect(html).toContain("GenAI Labs");
    expect(html).toContain("Inbox");
    expect(html).toContain("Hiring");
    expect(html).toContain("nav-item sub");
    expect(html).toContain("Candidates");
    expect(html).toContain("Workflows");
    expect(html).toContain("Settings");
    expect(html).toContain("nav-item on");
  });

  test("Rail draws icon buttons with titles", () => {
    const html = render(
      <Rail workspace={fx.navWorkspace} items={fx.railItems} tail={fx.railTail} active="inbox" />,
    );
    expect(html).toContain('class="rail"');
    expect(html).toContain('title="Hiring"');
    expect(html).toContain('class="on"');
  });
});

describe("MessageRow", () => {
  test("shows the unread dot only when unread", () => {
    const unread = render(<MessageRow thread={e1} tags={fx.tagsOf(e1)} now={fx.NOW} />);
    expect(e1.unread).toBe(true);
    expect(unread).toContain("row unread");
    expect(unread).toContain('class="dot" role="img" aria-label="Unread"');

    const read = render(<MessageRow thread={e4} tags={fx.tagsOf(e4)} now={fx.NOW} />);
    expect(e4.unread).toBe(false);
    expect(read).not.toContain("unread");
    expect(read).toContain('<span class="dot"></span>');
  });

  test("shows sender, count, subject, snippet, label and time", () => {
    const html = render(<MessageRow thread={e1} tags={fx.tagsOf(e1)} now={fx.NOW} selected />);
    expect(html).toContain("Aoife Brennan");
    expect(html).toContain('Aoife Brennan <span class="cnt">3</span>');
    expect(html).toContain(e1.subject);
    expect(html).toContain('class="lbl">Candidate<');
    expect(html).toContain('class="time">09:41<');
    expect(html).toContain("row unread on");
    expect(html).toContain("<svg");
  });

  test("older threads get a day label", () => {
    const html = render(<MessageRow thread={e4} now={fx.NOW} />);
    expect(html).toContain('class="time">Yesterday<');
    const e6 = fx.threadById("e6");
    if (!e6) throw new Error("e6 missing");
    expect(render(<MessageRow thread={e6} now={fx.NOW} />)).toContain('class="time">Mon<');
  });
});

describe("reader", () => {
  test("Brief lists bullets and up to three action chips", () => {
    const html = render(<Brief brief={brief1} source="Claude Code, on this machine" />);
    expect(html).toContain('class="brief"');
    expect(html).toContain("Aoife submitted the take-home");
    expect(html).toContain("Claude Code, on this machine");
    expect(html).toContain("Reply with Thursday 15:00");
    expect(html).toContain("Forward to Priya");
    expect(html).toContain("Add to calendar: Aoife Brennan, take-home");
    expect((html.match(/class="chip"/g) ?? []).length).toBe(3);
  });

  test("Message renders open with avatar, paragraphs and attachments", () => {
    const html = render(<Message message={m1c} now={fx.NOW} />);
    expect(html).toContain('class="msg"');
    expect(html).toContain('class="avatar"');
    expect(html).toContain("to Tejas");
    expect(html).toContain("Today 09:41");
    expect(html).toContain("<p>Hi Tejas,</p>");
    expect(html).toContain('class="attachments"');
    expect(html).toContain("take-home-writeup.pdf");
    expect(html).toContain("214 KB");
  });

  test("Message renders collapsed with a preview", () => {
    const html = render(<Message message={m1a} collapsed now={fx.NOW} />);
    expect(html).toContain("msg collapsed");
    expect(html).toContain('class="prev">Thanks for sending the brief.');
    expect(html).toContain("Mon 14:02");
  });

  test("Attachment picks an icon by media type", () => {
    const html = render(<Attachment attachment={firstAttachment} />);
    expect(html).toContain('class="att"');
    expect(html).toContain("<svg");
    expect(html).toContain('class="sz">214 KB<');
  });

  test("ReplyBox addresses the first name and offers a draft", () => {
    const html = render(<ReplyBox recipient="Aoife Brennan" onDraft={() => {}} />);
    expect(html).toContain('placeholder="Reply to Aoife"');
    expect(html).toContain("Draft a reply");
    expect(html).toContain("btn primary");
    expect(render(<ReplyBox recipient="Kenji Watanabe" />)).not.toContain("Draft a reply");
  });
});

describe("agent", () => {
  test("ToolCard maps status to class, icon and label", () => {
    const [, agentTurn] = fx.agentThread;
    if (agentTurn?.role !== "agent") throw new Error("fixture agent turn missing");
    const tools = agentTurn.parts.filter((p) => p.kind === "tool");
    const [search, event, send] = tools;
    if (search?.kind !== "tool" || !event || send?.kind !== "tool")
      throw new Error("fixture tool parts missing");

    const done = render(<ToolCard call={search.call} title={search.title} />);
    expect(done).toContain("tool ok");
    expect(done).toContain("Searched mail");
    expect(done).toContain("3 results");
    expect(done).toContain('data-tier="read-only"');

    const waiting = render(
      <ToolCard
        call={send.call}
        title={send.title}
        preview={send.preview}
        actions={send.actions}
      />,
    );
    expect(waiting).toContain("tool wait");
    expect(waiting).toContain("Needs approval");
    expect(waiting).toContain('class="preview"');
    expect(waiting).toContain("btn sm primary");
    expect((waiting.match(/class="btn sm/g) ?? []).length).toBe(3);

    const running = render(
      <ToolCard call={{ ...search.call, status: "running", tool: "read_attachment" }} />,
    );
    expect(running).toContain("tool run");
    expect(running).toContain("Read attachment");
    expect(running).toContain("Running");

    const failed = render(<ToolCard call={{ ...search.call, status: "failed" }} />);
    expect(failed).toContain("tool fail");
    expect(failed).toContain("Failed");
  });

  test("ResultsList lists threads with times", () => {
    const html = render(<ResultsList threads={fx.searchResults} now={fx.NOW} />);
    expect(html).toContain('class="results"');
    expect((html.match(/class="r"/g) ?? []).length).toBe(3);
    expect(html).toContain('class="t">Sep 8<');
  });

  test("AgentBar has the mark, an input and the enter key", () => {
    const html = render(<AgentBar />);
    expect(html).toContain('class="agent-bar"');
    expect(html).toContain('class="mk"');
    expect(html).toContain('placeholder="Ask or tell monday"');
    expect(html).toContain("↵");
  });

  test("AgentThread renders user bubbles, text, tool cards and results", () => {
    const html = render(<AgentThread turns={fx.agentThread} now={fx.NOW} />);
    expect(html).toContain('class="agent-thread"');
    expect(html).toContain('class="u">find everything from aoife');
    expect(html).toContain('class="a"');
    expect(html).toContain("<p>Found 3 messages from Aoife Brennan about the take-home.</p>");
    expect(html).toContain("tool ok");
    expect(html).toContain("tool wait");
    expect(html).toContain('class="results"');
  });

  test("AgentPanel, AgentDock and AgentColumn wrap the thread", () => {
    const panel = render(
      <AgentDock>
        <AgentPanel runtime="Claude Code · tejas@genai-labs.io" suggestions={fx.suggestions}>
          <AgentThread turns={fx.agentThreadLayout} now={fx.NOW} />
        </AgentPanel>
        <AgentBar placeholder="Reply, or ask something else" />
      </AgentDock>,
    );
    expect(panel).toContain('class="agent-dock"');
    expect(panel).toContain('class="agent-panel"');
    expect(panel).toContain("<h2>monday</h2>");
    expect(panel).toContain('class="agent-suggest"');
    expect(panel).toContain("Hide the sidebar");
    expect(panel).toContain("Changed layout");

    const column = render(
      <AgentColumn side="right" runtime="Claude Code">
        <AgentThread turns={fx.agentThreadShort} now={fx.NOW} />
        <AgentBar />
      </AgentColumn>,
    );
    expect(column).toContain("agent-col right");
    expect(column).toContain("Changed appearance");
  });
});

describe("overlays", () => {
  test("CommandPalette renders sections, the mark for agent items and keys", () => {
    const html = render(<CommandPalette sections={fx.commands} />);
    expect(html).toContain('class="scrim"');
    expect(html).toContain('class="cmdk"');
    expect(html).toContain('class="cmdk-sec">Ask the agent<');
    expect(html).toContain("cmdk-item on");
    expect(html).toContain('class="mk sm"');
    expect(html).toContain('class="kbd">G I<');
    expect(html).toContain("ask instead");
  });

  test("Scrim wraps children", () => {
    expect(render(<Scrim>x</Scrim>)).toContain('class="scrim"');
  });

  test("Compose shows the draft, the ghost completion and the agent note", () => {
    const html = render(
      <Compose draft={fx.draft} ghost={fx.draftGhost} note={{ text: fx.draftNote }} />,
    );
    expect(html).toContain('class="compose"');
    expect(html).toContain("<h2>Reply</h2>");
    expect(html).toContain('class="pill" title="kenji.w@meridianfund.co">Kenji Watanabe<');
    expect(html).toContain('value="Re: Term sheet redline, v3"');
    expect(html).toContain("<p>Kenji,</p>");
    expect(html).toContain('class="ghost"');
    expect(html).toContain('class="c-ai"');
    expect(html).toContain("Rewrite");
    expect(render(<Compose draft={{ ...fx.draft, threadId: null }} />)).toContain(
      "<h2>New message</h2>",
    );
  });
});

describe("settings and workflows", () => {
  test("SettingsField shows a label, hint and control", () => {
    const html = render(
      <SettingsField label="Ask before sending" hint="The agent shows a preview and waits for you">
        <Switch on />
      </SettingsField>,
    );
    expect(html).toContain('class="field"');
    expect(html).toContain("<b>Ask before sending</b>");
    expect(html).toContain("switch on");
  });

  test("Swatch previews a palette half with custom properties", () => {
    const html = render(<Swatch palette={palette} mode="dark" on />);
    expect(html).toContain("sw on");
    expect(html).toContain("--s-bg:#0c0c0e");
    expect(html).toContain("--s-accent:#7c96ff");
    expect(html).toContain("Graphite");
    expect(html).toContain("monday");
    expect(render(<Swatch palette={palette} mode="light" />)).toContain("--s-bg:#f4f4f5");
    expect(render(<CustomSwatch />)).toContain("sw custom");
  });

  test("every palette renders a swatch", () => {
    for (const p of palettes) {
      expect(render(<Swatch palette={p} mode="light" />)).toContain(p.label);
    }
    expect(palettes.length).toBe(7);
  });

  test("FlowChain joins nodes with edges", () => {
    const wf = fx.workflows[0];
    if (!wf) throw new Error("workflow fixture missing");
    const html = render(<FlowChain nodes={wf.flow} />);
    expect(html).toContain('class="flow"');
    expect((html.match(/class="node/g) ?? []).length).toBe(5);
    expect((html.match(/class="edge"/g) ?? []).length).toBe(4);
    expect(html).toContain("node trig");
    expect(html).toContain("node cond");
    expect(html).toContain('class="k">name, role, links<');
    expect(render(<FlowEdge />)).toContain('class="edge"');
    expect(render(<FlowNode kind="act" icon={SunIcon} label="Send" />)).toContain("node act");
  });
});

describe("theme", () => {
  function Probe() {
    const t = useTheme();
    return <pre>{JSON.stringify(t.attributes)}</pre>;
  }

  test("useTheme exposes the resolved attributes", () => {
    const html = render(
      <ThemeProvider
        mode="dark"
        palette="gruvbox"
        density="compact"
        layout={{ nav: "rail", agent: "left", list: "split" }}
      >
        <Probe />
      </ThemeProvider>,
    );
    expect(html).toContain("&quot;data-theme&quot;:&quot;dark&quot;");
    expect(html).toContain("&quot;data-palette&quot;:&quot;gruvbox&quot;");
    expect(html).toContain("&quot;data-density&quot;:&quot;compact&quot;");
    expect(html).toContain("&quot;data-layout&quot;:&quot;agent-left&quot;");
    expect(html).toContain("&quot;data-nav&quot;:&quot;rail&quot;");
    expect(html).toContain("&quot;data-agent&quot;:&quot;left&quot;");
    expect(html).toContain("&quot;data-list&quot;:&quot;split&quot;");
  });
});

describe("copy", () => {
  test("no rendered output contains an em-dash", () => {
    expect(rendered.length).toBeGreaterThan(30);
    for (const html of rendered) expect(html).not.toContain(EM_DASH);
  });

  test("no source, style or fixture string contains an em-dash", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx,css}");
    const dir = new URL("./", import.meta.url).pathname;
    const offenders: string[] = [];
    let files = 0;
    for await (const path of glob.scan({ cwd: dir })) {
      const text = await Bun.file(dir + path).text();
      if (text.includes(EM_DASH)) offenders.push(path);
      files++;
    }
    expect(offenders).toEqual([]);
    expect(files).toBeGreaterThan(10);
  });
});
