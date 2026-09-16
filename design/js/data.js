// Mock data for the design lock-in. Names and content are invented.
export const workspace = {
  name: "GenAI Labs",
  email: "tejas@genai-labs.io",
  initials: "GL",
  accounts: ["tejas@genai-labs.io", "tejas@hey.com", "hello@monday.email"],
};

export const people = {
  aoife: { name: "Aoife Brennan", email: "aoife@northlight.dev", c: "var(--tag-1)" },
  kenji: { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co", c: "var(--tag-5)" },
  mateus: { name: "Mateus Ferreira", email: "mateus@ferreira.design", c: "var(--tag-3)" },
  ngozi: { name: "Ngozi Adeyemi", email: "ngozi.adeyemi@gmail.com", c: "var(--tag-4)" },
  sofia: { name: "Sofia Lindqvist", email: "sofia@lindqvist.se", c: "var(--tag-2)" },
  tomasz: { name: "Tomasz Kowalczyk", email: "t.kowalczyk@proton.me", c: "var(--tag-1)" },
  ravi: { name: "Ravi Shankar", email: "ravi@genai-labs.io", c: "var(--tag-5)" },
  priya: { name: "Priya Raghunathan", email: "priya@genai-labs.io", c: "var(--tag-4)" },
  hetzner: { name: "Hetzner Cloud", email: "billing@hetzner.com", c: "var(--fg-muted)" },
  github: { name: "GitHub", email: "noreply@github.com", c: "var(--fg)" },
  stripe: { name: "Stripe", email: "receipts@stripe.com", c: "var(--tag-1)" },
  linear: { name: "Linear", email: "updates@linear.app", c: "var(--fg-muted)" },
  bytes: { name: "Bytes Newsletter", email: "bytes@ui.dev", c: "var(--tag-3)" },
  me: { name: "Tejas", email: "tejas@genai-labs.io", c: "var(--accent)" },
};

const p = people;
export const emails = [
  {
    id: "e1", from: p.aoife, to: [p.me], time: "09:41", dayKey: "today", unread: true, count: 3,
    subject: "Re: Senior Rust engineer role, take-home submitted",
    snippet: "Attached the repo link and a short write-up. Happy to walk through the design decisions on a call this week.",
    tags: [{ t: "Candidate", k: "t4" }, { t: "Needs reply", k: "warn" }],
    att: true, group: "needs-reply",
    brief: [
      "<b>Aoife submitted the take-home</b> for the Senior Rust role. Repo plus a 2-page write-up.",
      "She proposes a <b>call this week</b>, available Wed or Thu after 14:00 CET.",
      "Routed to <b>Hiring › Candidates</b>. Workflow <i>Candidate intake</i> already posted the summary to Notion.",
    ],
    actions: ["Reply with Thursday 15:00", "Forward to Priya", "Add to interview calendar"],
    thread: [
      { who: p.aoife, when: "Mon 14:02", collapsed: true, prev: "Thanks for sending the brief. I will have it back by Wednesday." },
      { who: p.me, when: "Mon 15:10", collapsed: true, prev: "No rush, take the time you need. Looking forward to it." },
      { who: p.aoife, when: "Today 09:41", body: [
        "Hi Tejas,",
        "I have finished the take-home. The repo is public at <u>github.com/aoifeb/mail-sync-rs</u> and I attached a short write-up covering the sync model, back-pressure handling, and what I would change with more time.",
        "The most interesting call was choosing a pull-based cursor per mailbox over a single global cursor. Happy to walk you through it on a call this week, I am free Wednesday or Thursday after 14:00 CET.",
        "Best,<br>Aoife",
      ], atts: [{ name: "take-home-writeup.pdf", size: "214 KB", ic: "ph-file-pdf" }, { name: "sync-model.png", size: "88 KB", ic: "ph-image" }] },
    ],
    drafts: ["Confirm Thursday 15:00 CET", "Ask for a 30 min slot Wednesday", "Thank and say we will review first"],
  },
  {
    id: "e2", from: p.kenji, to: [p.me, p.ravi], time: "08:15", dayKey: "today", unread: true, count: 1,
    subject: "Term sheet redline, v3",
    snippet: "Two changes from our side: the pro-rata clause and the board observer seat. Everything else matches what we discussed.",
    tags: [{ t: "Investor", k: "t1" }, { t: "Needs reply", k: "warn" }], att: true, group: "needs-reply",
    brief: ["<b>Two redlines</b>: pro-rata rights capped at 1x, and a board observer seat instead of a full seat.", "Kenji wants a <b>reply by Friday</b> to keep the closing date.", "Ravi is cc'd and has not replied yet."],
    actions: ["Draft acceptance of pro-rata cap", "Ask Ravi for a read", "Snooze until Thursday"],
    thread: [{ who: p.kenji, when: "Today 08:15", body: ["Tejas, Ravi,", "Attached v3 of the term sheet with our two changes marked. The pro-rata clause is now capped at 1x and we moved to a board observer seat, which is standard for us at this stage.", "Everything else matches what we agreed on the call. If we can close on this by Friday we keep the original date.", "Kenji"], atts: [{ name: "term-sheet-v3-redline.docx", size: "96 KB", ic: "ph-file-doc" }] }],
    drafts: ["Accept both changes", "Accept pro-rata, push back on observer seat", "Ask for a call before Friday"],
  },
  {
    id: "e3", from: p.ngozi, to: [p.me], time: "Yesterday", dayKey: "yesterday", unread: false, count: 2,
    subject: "Application: Design Engineer",
    snippet: "I saw the opening on your site. Portfolio and CV attached, I have been building design tooling at a fintech for three years.",
    tags: [{ t: "Candidate", k: "t4" }], att: true, group: "needs-reply",
    brief: ["Ngozi applied for <b>Design Engineer</b>. Three years at a fintech building internal design tooling.", "Portfolio links to a component library and a Figma plugin.", "No reply from us yet, <b>2 days old</b>."],
    actions: ["Send screening questions", "Schedule intro call", "Decline politely"],
    thread: [{ who: p.ngozi, when: "Yesterday 17:20", body: ["Hello,", "I saw the Design Engineer opening on your site. I have spent the last three years at a fintech building the design system and internal tooling around it, including a Figma plugin that generates tokens for our web and mobile apps.", "Portfolio and CV attached. I would love to talk about what you are building.", "Ngozi"], atts: [{ name: "ngozi-adeyemi-cv.pdf", size: "180 KB", ic: "ph-file-pdf" }] }],
    drafts: ["Invite to a 30 min intro call", "Send the screening questions", "Thank and decline"],
  },
  {
    id: "e4", from: p.mateus, to: [p.me], time: "Yesterday", dayKey: "yesterday", unread: false, count: 5,
    subject: "Icon set round 2",
    snippet: "Pushed the second round to Figma. Went with 1.5px strokes throughout and squared off the terminals like you asked.",
    tags: [{ t: "Design", k: "t3" }], att: false, group: "waiting",
    brief: ["Round 2 of the icon set is in Figma with <b>1.5px strokes</b> and squared terminals.", "Mateus is waiting on <b>your review</b> of the 12 new glyphs.", "Invoice for round 1 is still unpaid (see Finance › Invoices)."],
    actions: ["Open Figma file", "Reply: looks good, ship it", "Ask for outlined variants"],
    thread: [{ who: p.mateus, when: "Yesterday 11:05", body: ["Hey Tejas,", "Round 2 is up in Figma. I went with 1.5px strokes throughout and squared off the terminals as we discussed. The 12 new glyphs for the workflow nodes are on the second page.", "Let me know what you think and I will start on the filled variants.", "Mateus"] }],
    drafts: ["Approve and ask for filled variants", "Request two changes", "Schedule a review call"],
  },
  {
    id: "e5", from: p.sofia, to: [p.me], time: "Yesterday", dayKey: "yesterday", unread: false, count: 1,
    subject: "Podcast invite: building email clients in 2026",
    snippet: "We are recording a series on people rebuilding old software categories. Would you be up for 45 minutes in October?",
    tags: [{ t: "Press", k: "t2" }], att: false, group: "waiting",
    brief: ["Invite to a <b>45 min podcast</b> recording in October.", "Series is about rebuilding old software categories.", "No date proposed yet."],
    actions: ["Accept and propose dates", "Ask for the audience size", "Decline"],
    thread: [{ who: p.sofia, when: "Yesterday 09:30", body: ["Hi Tejas,", "We are recording a short series on people rebuilding old software categories, and an email client with an agent in it is a good fit. Would you be up for a 45 minute recording sometime in October? Remote is fine.", "Sofia"] }],
    drafts: ["Accept, propose two October dates", "Ask for more details", "Decline"],
  },
  {
    id: "e6", from: p.tomasz, to: [p.me], time: "Mon", dayKey: "week", unread: false, count: 1,
    subject: "NixOS module for monday",
    snippet: "I wrote a home-manager module that generates monday.toml from the stylix palette. Want it upstream?",
    tags: [{ t: "Community", k: "t5" }], att: false, group: "fyi",
    brief: ["Tomasz built a <b>home-manager module</b> that generates <code>monday.toml</code> from a Stylix palette.", "Asks whether to open a PR upstream.", "Good candidate for the docs."],
    actions: ["Reply: yes, open a PR", "Ask for a screenshot", "Star on GitHub"],
    thread: [{ who: p.tomasz, when: "Mon 21:14", body: ["Hey,", "I have been running monday on NixOS with my stylix palette and wrote a small home-manager module that writes monday.toml from it, so the client follows my rice automatically. Happy to upstream it if you want, it is about 80 lines.", "Tomasz"] }],
    drafts: ["Yes please, open a PR", "Ask to see the module first"],
  },
  {
    id: "e7", from: p.hetzner, to: [p.me], time: "Mon", dayKey: "week", unread: false, count: 1,
    subject: "Invoice 2026-09 for project monday-sync",
    snippet: "Your invoice for September is available. Amount: 41.60 EUR. It will be charged to your card on file.",
    tags: [{ t: "Invoice", k: "t2" }], att: true, group: "fyi",
    brief: ["September invoice for the <b>sync server</b>: 41.60 EUR.", "Auto-charged, nothing to do.", "Workflow <i>Invoices to Drive</i> saved the PDF."],
    actions: ["Open PDF", "Forward to accounting"],
    thread: [{ who: p.hetzner, when: "Mon 06:00", body: ["Your invoice for September 2026 for project monday-sync is available in your account. Amount: 41.60 EUR. It will be charged to your card on file within the next days."], atts: [{ name: "R0012345678.pdf", size: "44 KB", ic: "ph-file-pdf" }] }],
    drafts: [],
  },
  {
    id: "e8", from: p.github, to: [p.me], time: "Sun", dayKey: "week", unread: false, count: 1,
    subject: "[monday-email/sync] PR #142: Gmail push notifications via Pub/Sub",
    snippet: "priya-r requested your review on this pull request.",
    tags: [{ t: "Review", k: "t1" }], att: false, group: "fyi",
    brief: ["Priya opened <b>PR #142</b> adding Gmail Pub/Sub push notifications to the sync server.", "Requested your review, 14 files changed.", "CI is green."],
    actions: ["Open on GitHub", "Ask agent to summarize the diff"],
    thread: [{ who: p.github, when: "Sun 22:40", body: ["priya-r requested your review on pull request #142: Gmail push notifications via Pub/Sub.", "14 files changed, +612 / -88. All checks have passed."] }],
    drafts: [],
  },
  {
    id: "e9", from: p.stripe, to: [p.me], time: "Sun", dayKey: "week", unread: false, count: 1,
    subject: "Your receipt from Anthropic, 48.00 USD",
    snippet: "Receipt for API usage in August.",
    tags: [{ t: "Receipt", k: "t2" }], att: true, group: "fyi",
    brief: ["Anthropic API receipt for August: 48.00 USD.", "Filed under Finance › Receipts."],
    actions: ["Open PDF"], thread: [{ who: p.stripe, when: "Sun 03:12", body: ["Receipt from Anthropic. Amount paid: 48.00 USD. Thanks for your business."], atts: [{ name: "receipt-2026-08.pdf", size: "31 KB", ic: "ph-file-pdf" }] }], drafts: [],
  },
  {
    id: "e10", from: p.bytes, to: [p.me], time: "Sat", dayKey: "week", unread: false, count: 1,
    subject: "Bytes #412: the return of the desktop app",
    snippet: "Tauri 2.x, native webviews, and why everyone is shipping desktop again.",
    tags: [{ t: "Newsletter", k: "t3" }], att: false, group: "newsletters",
    brief: ["Issue on the desktop app comeback, mentions Tauri 2.x.", "3 min read according to the agent."],
    actions: ["Summarize in 3 bullets", "Unsubscribe"], thread: [{ who: p.bytes, when: "Sat 14:00", body: ["This week: Tauri 2.x, native webviews, and why everyone is shipping desktop again."] }], drafts: [],
  },
  {
    id: "e11", from: p.linear, to: [p.me], time: "Sat", dayKey: "week", unread: false, count: 1,
    subject: "Weekly digest: 12 issues completed",
    snippet: "Your team closed 12 issues this week. 3 are waiting on your review.",
    tags: [{ t: "Newsletter", k: "t3" }], att: false, group: "newsletters",
    brief: ["12 issues closed, 3 waiting on you."], actions: ["Open Linear"], thread: [{ who: p.linear, when: "Sat 08:00", body: ["Your team closed 12 issues this week. 3 are waiting on your review."] }], drafts: [],
  },
];

export const groups = [
  { key: "needs-reply", label: "Needs your reply", icon: "ph-arrow-bend-up-left", ai: "sorted by urgency" },
  { key: "waiting", label: "Waiting on you", icon: "ph-hourglass", ai: "" },
  { key: "fyi", label: "For your information", icon: "ph-info", ai: "" },
  { key: "newsletters", label: "Newsletters", icon: "ph-newspaper", ai: "auto-archived after 7 days" },
];

export const nav = {
  main: [
    { key: "inbox", label: "Inbox", icon: "ph-tray", n: 14, hot: true },
    { key: "starred", label: "Starred", icon: "ph-star", n: 3 },
    { key: "snoozed", label: "Snoozed", icon: "ph-clock", n: 5 },
    { key: "drafts", label: "Drafts", icon: "ph-note-pencil", n: 2 },
    { key: "sent", label: "Sent", icon: "ph-paper-plane-tilt" },
    { key: "archive", label: "Archive", icon: "ph-archive" },
  ],
  smart: [
    { key: "hiring", label: "Hiring", icon: "ph-users-three", n: 6, smart: true, color: "var(--tag-4)", children: [
      { key: "candidates", label: "Candidates", n: 4 }, { key: "interviews", label: "Interviews", n: 2 }, { key: "rejected", label: "Rejected" },
    ] },
    { key: "finance", label: "Finance", icon: "ph-receipt", n: 2, smart: true, color: "var(--tag-2)", children: [
      { key: "invoices", label: "Invoices", n: 1 }, { key: "receipts", label: "Receipts", n: 1 },
    ] },
    { key: "investors", label: "Investors", icon: "ph-handshake", n: 1, smart: true, color: "var(--tag-1)" },
    { key: "community", label: "Community", icon: "ph-github-logo", n: 3, smart: true, color: "var(--tag-5)" },
    { key: "press", label: "Press", icon: "ph-microphone", smart: true, color: "var(--tag-3)" },
  ],
  automation: [
    { key: "workflows", label: "Workflows", icon: "ph-flow-arrow", n: 3, running: true },
    { key: "routing", label: "Routing", icon: "ph-git-branch" },
  ],
};

export const workflows = [
  {
    id: "w1", name: "Candidate intake", on: true, where: "server",
    desc: "When a candidate emails about any open role, extract name, role and links, post a summary to the Hiring Notion database, label the thread and ping #hiring on Slack if the role is Rust.",
    flow: [
      { k: "trig", i: "ph-envelope-simple", t: "Email arrives", s: "matches Hiring › Candidates" },
      { k: "act", i: "ph-brain", t: "Extract", s: "name, role, links" },
      { k: "act", i: "ph-notion-logo", t: "Notion", s: "add row to Hiring" },
      { k: "cond", i: "ph-git-branch", t: "If role is Rust" },
      { k: "act", i: "ph-slack-logo", t: "Slack", s: "#hiring" },
    ],
    runs: [1,1,1,1,0,1,1,1,1,1,1,1], last: "9 min ago", today: 3,
    log: [
      { ok: true, t: "9 min ago", m: "Aoife Brennan, Senior Rust engineer", d: "Notion row created, Slack posted to #hiring" },
      { ok: true, t: "Yesterday 17:21", m: "Ngozi Adeyemi, Design Engineer", d: "Notion row created" },
      { ok: false, t: "Sun 10:04", m: "Unknown sender, no role detected", d: "Skipped: confidence 0.31, asked you to confirm" },
    ],
  },
  {
    id: "w2", name: "Invoices to Drive", on: true, where: "server",
    desc: "Save every invoice or receipt PDF into Google Drive under Finance/2026, rename it to vendor-date-amount, and reply to accounting on the first of each month with the list.",
    flow: [
      { k: "trig", i: "ph-paperclip", t: "Attachment", s: "PDF in Finance" },
      { k: "act", i: "ph-brain", t: "Read", s: "vendor, date, amount" },
      { k: "act", i: "ph-google-drive-logo", t: "Drive", s: "Finance/2026" },
      { k: "trig", i: "ph-calendar-blank", t: "1st of month" },
      { k: "act", i: "ph-paper-plane-tilt", t: "Send", s: "monthly list" },
    ],
    runs: [1,1,1,1,1,1,1,1,1,1,1,1], last: "Mon 06:01", today: 0,
    log: [
      { ok: true, t: "Mon 06:01", m: "Hetzner, 41.60 EUR", d: "Saved as hetzner-2026-09-41.60.pdf" },
      { ok: true, t: "Sun 03:13", m: "Anthropic, 48.00 USD", d: "Saved as anthropic-2026-08-48.00.pdf" },
    ],
  },
  {
    id: "w3", name: "Investor follow-up nudge", on: true, where: "local",
    desc: "If an email in Investors has no reply from me after 2 working days, draft a follow-up in my voice and leave it in Drafts, then remind me at 9am.",
    flow: [
      { k: "trig", i: "ph-timer", t: "No reply", s: "2 working days" },
      { k: "cond", i: "ph-git-branch", t: "If in Investors" },
      { k: "act", i: "ph-note-pencil", t: "Draft", s: "in my voice" },
      { k: "act", i: "ph-bell", t: "Remind", s: "09:00" },
    ],
    runs: [1,1,0,1,1,1], last: "Fri 09:00", today: 0,
    log: [{ ok: true, t: "Fri 09:00", m: "Meridian Fund intro", d: "Draft left in Drafts, reminder fired" }],
  },
  {
    id: "w4", name: "Newsletter digest", on: false, where: "local",
    desc: "Every Friday at 16:00 summarize the week's newsletters into one email to myself, then archive the originals.",
    flow: [
      { k: "trig", i: "ph-calendar-check", t: "Fridays 16:00" },
      { k: "act", i: "ph-brain", t: "Summarize", s: "Newsletters group" },
      { k: "act", i: "ph-paper-plane-tilt", t: "Send", s: "to me" },
      { k: "act", i: "ph-archive", t: "Archive", s: "originals" },
    ],
    runs: [1,1,1,1], last: "Sep 5", today: 0, log: [{ ok: true, t: "Sep 5 16:00", m: "7 newsletters", d: "Digest sent, originals archived" }],
  },
];

export const routing = [
  {
    key: "hiring", label: "Hiring", color: "var(--tag-4)", n: 6,
    rule: "Emails from people applying to a role, replying to a job post, or sent by a recruiter. Looks for CVs, portfolio links and role names from <code>careers.genai-labs.io</code>.",
    conf: 0.94,
    subs: [
      { label: "Candidates", d: "first contact and take-home submissions", n: 4, i: "ph-user-plus" },
      { label: "Interviews", d: "scheduling threads and calendar replies", n: 2, i: "ph-calendar" },
      { label: "Rejected", d: "threads where we declined, auto-archived after 30 days", n: 0, i: "ph-archive" },
    ],
    samples: [{ who: "Aoife Brennan", s: "Re: Senior Rust engineer role, take-home submitted", to: "Candidates" }, { who: "Ngozi Adeyemi", s: "Application: Design Engineer", to: "Candidates" }, { who: "Calendly", s: "New event: Intro call with Ola Nordmann", to: "Interviews" }],
  },
  {
    key: "finance", label: "Finance", color: "var(--tag-2)", n: 2,
    rule: "Invoices, receipts and payment notices. Anything with an amount and a vendor, or from <code>billing@</code>, <code>receipts@</code>, Stripe or Hetzner.",
    conf: 0.98,
    subs: [
      { label: "Invoices", d: "money we owe", n: 1, i: "ph-receipt" },
      { label: "Receipts", d: "money already paid", n: 1, i: "ph-check-circle" },
    ],
    samples: [{ who: "Hetzner Cloud", s: "Invoice 2026-09 for project monday-sync", to: "Invoices" }, { who: "Stripe", s: "Your receipt from Anthropic, 48.00 USD", to: "Receipts" }],
  },
  {
    key: "investors", label: "Investors", color: "var(--tag-1)", n: 1,
    rule: "Anyone at Meridian Fund, Kestrel Ventures or Ada Capital, plus threads mentioning term sheets, SAFE notes or cap tables.",
    conf: 0.91, subs: [],
    samples: [{ who: "Kenji Watanabe", s: "Term sheet redline, v3", to: "Investors" }],
  },
  {
    key: "community", label: "Community", color: "var(--tag-5)", n: 3,
    rule: "GitHub notifications for <code>monday-email/*</code>, Discord digests, and people writing in about self-hosting or contributing.",
    conf: 0.89, subs: [],
    samples: [{ who: "Tomasz Kowalczyk", s: "NixOS module for monday", to: "Community" }, { who: "GitHub", s: "[monday-email/sync] PR #142", to: "Community" }],
  },
];

export const palettes = [
  { key: "graphite", label: "Graphite", by: "monday", light: { bg: "#f4f4f5", panel: "#ffffff", fg: "#18181b", accent: "#3d63dd", border: "rgba(24,24,27,.1)" }, dark: { bg: "#0c0c0e", panel: "#131316", fg: "#ececef", accent: "#7c96ff", border: "rgba(255,255,255,.1)" } },
  { key: "catppuccin", label: "Catppuccin", by: "Latte / Mocha", light: { bg: "#e6e9ef", panel: "#eff1f5", fg: "#4c4f69", accent: "#8839ef", border: "rgba(76,79,105,.14)" }, dark: { bg: "#181825", panel: "#1e1e2e", fg: "#cdd6f4", accent: "#cba6f7", border: "rgba(205,214,244,.1)" } },
  { key: "gruvbox", label: "Gruvbox", by: "Light / Dark", light: { bg: "#f2e5bc", panel: "#fbf1c7", fg: "#3c3836", accent: "#d65d0e", border: "rgba(60,56,54,.14)" }, dark: { bg: "#1d2021", panel: "#282828", fg: "#ebdbb2", accent: "#fe8019", border: "rgba(235,219,178,.1)" } },
  { key: "nord", label: "Nord", by: "Snow Storm / Polar Night", light: { bg: "#e5e9f0", panel: "#eceff4", fg: "#2e3440", accent: "#5e81ac", border: "rgba(46,52,64,.14)" }, dark: { bg: "#272c36", panel: "#2e3440", fg: "#eceff4", accent: "#88c0d0", border: "rgba(236,239,244,.1)" } },
  { key: "tokyonight", label: "Tokyo Night", by: "Day / Night", light: { bg: "#d5d6db", panel: "#e1e2e7", fg: "#343b58", accent: "#2e7de9", border: "rgba(55,96,191,.14)" }, dark: { bg: "#16161e", panel: "#1a1b26", fg: "#c0caf5", accent: "#7aa2f7", border: "rgba(192,202,245,.1)" } },
  { key: "rosepine", label: "Rosé Pine", by: "Dawn / Main", light: { bg: "#f2e9e1", panel: "#faf4ed", fg: "#575279", accent: "#907aa9", border: "rgba(87,82,121,.14)" }, dark: { bg: "#16141f", panel: "#191724", fg: "#e0def4", accent: "#c4a7e7", border: "rgba(224,222,244,.1)" } },
  { key: "everforest", label: "Everforest", by: "Light / Dark", light: { bg: "#f4f0d9", panel: "#fdf6e3", fg: "#5c6a72", accent: "#8da101", border: "rgba(92,106,114,.14)" }, dark: { bg: "#232a2e", panel: "#2d353b", fg: "#d3c6aa", accent: "#a7c080", border: "rgba(211,198,170,.1)" } },
];

export const layouts = [
  { key: "columns", label: "Columns", desc: "Classic three panes. The agent lives in a floating bar at the bottom and rises into a panel when you talk to it." },
  { key: "agent-left", label: "Agent left", desc: "The agent is a permanent column next to an icon rail. Conversation history stays visible while you read and triage." },
  { key: "stream", label: "Stream", desc: "One wide, AI-sectioned list. Reading opens as a sheet over the stream. Built for fast triage." },
];

export const agentThread = [
  { u: "find everything from aoife about the take-home and set up a call thursday 3pm" },
  { a: [
    { p: "Found 3 messages from Aoife Brennan about the take-home." },
    { tool: { i: "ph-magnifying-glass", t: "Searched mail", d: "from:aoife \"take-home\" · 1,204 messages scanned", st: "ok", stt: "3 results" } },
    { results: [
      { b: "Re: Senior Rust engineer role, take-home submitted", s: "Attached the repo link and a short write-up", t: "09:41" },
      { b: "Re: Senior Rust engineer role", s: "Thanks for sending the brief. I will have it back", t: "Mon" },
      { b: "Senior Rust engineer role", s: "Hi Aoife, thanks for applying. Here is the take-home brief", t: "Sep 8" },
    ] },
    { tool: { i: "ph-calendar-plus", t: "Created calendar event", d: "Thu Sep 18, 15:00 to 15:45 CET · Aoife Brennan, you", st: "ok", stt: "Done" } },
    { tool: { i: "ph-paper-plane-tilt", t: "Send reply to Aoife", d: "Confirms Thursday 15:00 CET, includes the meeting link", st: "wait", stt: "Needs approval", preview: "Hi Aoife, thanks for the write-up, the cursor-per-mailbox choice is exactly what I hoped to see. Thursday 15:00 CET works, here is the link: meet.genai-labs.io/aoife", acts: ["Send", "Edit", "Cancel"] } },
  ] },
];

export const agentThreadShort = [
  { u: "switch to gruvbox dark and make the font a bit bigger" },
  { a: [
    { tool: { i: "ph-palette", t: "Changed appearance", d: "palette: gruvbox · theme: dark · font size: 13 → 14", st: "ok", stt: "Applied" } },
    { p: "Done. I also wrote the change to <span class=\"mono\">~/.config/monday/monday.toml</span> so it survives restarts. Say <i>undo</i> to go back." },
  ] },
];

export const suggestions = [
  { i: "ph-lightning", t: "Reply to the 3 threads waiting on me" },
  { i: "ph-broom", t: "Archive newsletters older than a week" },
  { i: "ph-sidebar-simple", t: "Hide the sidebar", set: { nav: "hidden" } },
  { i: "ph-columns", t: "Put the agent on the right", set: { agent: "right" } },
];

export const agentThreadLayout = [
  { u: "hide the sidebar, sit on the right, and give invoice threads a forward-to-accounting button" },
  { a: [
    { tool: { i: "ph-layout", t: "Changed layout", d: "nav: hidden · agent: right · saved to your settings, synced to all devices", st: "ok", stt: "Applied", acts: ["Undo"], sets: [{ nav: "full", agent: "bottom" }] } },
    { tool: { i: "ph-plus-circle", t: "Added action to Finance › Invoices", d: "Reader toolbar: Forward to accounting → accounting@genai-labs.io", st: "ok", stt: "Applied" } },
    { tool: { i: "ph-bookmark-simple", t: "Saved as view", d: "Focus · ⌘3 · your previous layout is still ⌘1", st: "ok", stt: "Saved" } },
    { p: "Done. I can also change what the stream sections are, what a row shows, the reader toolbar, shortcuts, or add a panel from the catalog. Say <i>undo</i> at any point." },
  ] },
];

export const commands = [
  { sec: "Ask the agent", items: [
    { i: "ph-sparkle", t: "Summarize what I missed since yesterday", ai: true },
    { i: "ph-sparkle", t: "Draft a reply to Kenji accepting the pro-rata cap", ai: true },
  ] },
  { sec: "Actions", items: [
    { i: "ph-note-pencil", t: "New message", k: "C" },
    { i: "ph-archive", t: "Archive", k: "E" },
    { i: "ph-clock", t: "Snooze", k: "H" },
    { i: "ph-tag", t: "Label", k: "L" },
    { i: "ph-flow-arrow", t: "New workflow from this thread" },
  ] },
  { sec: "Go to", items: [
    { i: "ph-tray", t: "Inbox", k: "G I" }, { i: "ph-users-three", t: "Hiring › Candidates", k: "G H" }, { i: "ph-gear", t: "Settings", k: "⌘ ," },
  ] },
];

export const toml = `<span class="c"># ~/.config/monday/monday.toml</span>
<span class="c"># Reloaded live. Keys set here win over settings saved in the app.</span>

<span class="h">[appearance]</span>
<span class="k">theme</span>     = <span class="s">"system"</span>       <span class="c"># light | dark | system</span>
<span class="k">palette</span>   = <span class="s">"gruvbox"</span>      <span class="c"># or path to a custom palette file</span>
<span class="k">density</span>   = <span class="s">"comfortable"</span>  <span class="c"># compact | comfortable | spacious</span>
<span class="k">font</span>      = <span class="s">"Geist Variable"</span>
<span class="k">font_size</span> = 14

<span class="h">[layout]</span>
<span class="k">preset</span>    = <span class="s">"stream"</span>       <span class="c"># stream | columns | agent-left | custom</span>
<span class="k">nav</span>       = <span class="s">"full"</span>         <span class="c"># full | rail | hidden</span>
<span class="k">agent</span>     = <span class="s">"bottom"</span>       <span class="c"># bottom | left | right</span>
<span class="k">list</span>      = <span class="s">"stream"</span>       <span class="c"># stream | split</span>
<span class="k">row</span>       = <span class="s">"two-line"</span>     <span class="c"># one-line | two-line | card</span>
<span class="k">sections</span>  = [<span class="s">"needs-reply"</span>, <span class="s">"waiting"</span>, <span class="s">"fyi"</span>, <span class="s">"newsletters"</span>]

<span class="h">[views.focus]</span>                     <span class="c"># a view pinned from the file, ⌘3</span>
<span class="k">nav</span>       = <span class="s">"hidden"</span>
<span class="k">agent</span>     = <span class="s">"right"</span>

<span class="h">[actions.reader]</span>
<span class="k">invoices</span>  = [{ <span class="k">label</span> = <span class="s">"Forward to accounting"</span>, <span class="k">to</span> = <span class="s">"accounting@genai-labs.io"</span> }]

<span class="h">[appearance.palette.overrides]</span>
<span class="k">accent</span>    = <span class="s">"#fe8019"</span>
<span class="k">bg</span>        = <span class="s">"#1d2021"</span>

<span class="h">[ai]</span>
<span class="k">mode</span>      = <span class="s">"local"</span>        <span class="c"># api | local</span>
<span class="k">local.cli</span> = <span class="s">"claude"</span>       <span class="c"># claude | codex | opencode</span>
<span class="k">api.provider</span> = <span class="s">"anthropic"</span>
<span class="k">api.model</span>    = <span class="s">"claude-fable-5-1"</span>

<span class="h">[server]</span>
<span class="k">url</span>       = <span class="s">"https://sync.genai-labs.io"</span>
<span class="k">run_workflows_when_offline</span> = true`;
