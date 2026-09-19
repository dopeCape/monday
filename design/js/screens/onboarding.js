// Onboarding (docs/spec/onboarding.md): the first screen with the three
// choices, and the conversation that follows for "Mail with an assistant" and
// "Mail that sorts and acts for me". Hash routes: #/onboarding (the cards) and
// #/onboarding/chat (the conversation). The cards use the same primitives as
// the Sync server upgrade cards; calm and spacious, no sparkle glyphs.

import { agentBar, threadHtml } from "../components.js";

const levels = [
  {
    key: "off",
    t: "Just mail",
    s: "No AI at all. A fast mail client with Groups you make by hand, search, keymaps and the calendar. No provider key asked for.",
  },
  {
    key: "assist",
    t: "Mail with an assistant",
    s: "The agent bar and what it reaches: draft, find, summarize, change settings, undo. Briefs when you open a thread. Nothing runs without you asking.",
  },
  {
    key: "automate",
    t: "Mail that sorts and acts for me",
    s: "Everything: routing into Groups, Briefs in the background, Workflows with their approvals.",
    on: true,
  },
];

function cards(items) {
  return `<div class="choice-cards" data-count="${items.length}">${items
    .map(
      (c) =>
        `<button class="choice-card ${c.on ? "on" : ""}" data-value="${c.key}"><b>${c.t}</b><span>${c.s}</span></button>`,
    )
    .join("")}</div>`;
}

const conversation = [
  { u: "Set me up." },
  { a: [{ tool: { t: "onboarding context", st: "ok", stt: "Applied", d: "" } }, { p: "Who are you and what do you do?" }] },
  { u: "I run a small studio with two people." },
  { a: [{ p: "What mail matters most to you?" }] },
  { u: "Aoife Brennan, Kenji Watanabe" },
  { a: [{ p: "Which tools do you use: Slack, Notion, Drive, Discord?" }] },
  { u: "Drive" },
  { a: [{ p: "May monday learn your voice from your sent mail?" }] },
  { u: "Skip" },
  { a: [{ p: "May monday read the last 30 days of mail to propose Groups?" }] },
  { u: "Yes" },
  {
    a: [
      { p: "Here is what I would set up." },
      {
        tool: {
          t: "propose groups",
          st: "wait",
          stt: "Needs approval",
          d: "Hiring, Finance, Investors",
          preview:
            "Hiring: Candidates, recruiters and interview threads. (6 threads would move)<br>Finance: Invoices, receipts and payment notices. (2 threads would move)<br>Investors: Mail from Meridian and the other funds. (3 threads would move)<br>Over the newest 50 threads. Nothing moves until you approve; one Undo puts it all back.",
          acts: ["Apply", "Cancel"],
        },
      },
    ],
  },
];

function first() {
  return `
  <div class="main page">
    <div class="onboarding">
      <div class="onboarding-in">
        <h1>What do you want from monday?</h1>
        <p>Your mail is syncing. Pick how much monday should do; the choice is yours and you can change it any time.</p>
        ${cards(levels)}
        <p class="choice-note">Yours to change at any time. Moving down disables, never deletes; moving up brings everything back.</p>
        <div class="actions"><span class="sp"></span><button class="btn">Skip</button><button class="btn primary">Continue</button></div>
      </div>
    </div>
  </div>`;
}

function chat() {
  return `
  <div class="main page">
    <div class="onboarding">
      <div class="onboarding-in">
        <h1>A few questions</h1>
        <p>Five at most, each answerable in a sentence or a chip. Skip any of them; closing skips the rest.</p>
        <div class="onboarding-chat">
          <div class="onboarding-chips"><button class="chip">Skip</button></div>
          <section class="agent-col right">
            <div class="col-head"><h2>monday</h2><span class="count">Claude Code · tejas@genai-labs.io</span><span class="sp"></span></div>
            <div class="agent-thread">${threadHtml(conversation)}</div>
            ${agentBar("Reply, or ask something else")}
          </section>
        </div>
        <div class="actions"><span class="sp"></span><button class="btn">Skip the rest</button></div>
      </div>
    </div>
  </div>`;
}

export function render(route) {
  return route.id === "chat" ? chat() : first();
}
