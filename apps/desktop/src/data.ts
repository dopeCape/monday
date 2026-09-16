export type Mail = {
  id: number;
  name: string;
  initials: string;
  color: string;
  subject: string;
  preview: string;
  time: string;
  group: string;
  unread?: boolean;
  attachment?: string;
  body: string[];
};
export const mails: Mail[] = [
  {
    id: 1,
    name: "Sofia Chen",
    initials: "SC",
    color: "sage",
    subject: "A little more room to breathe",
    preview: "The new direction is feeling really good. A few thoughts…",
    time: "10:42",
    group: "Design partners",
    unread: true,
    attachment: "Monday · direction 02.fig",
    body: [
      "Hey Alex,",
      "I spent some time with the latest explorations this morning. The new direction is feeling really good. There’s something about the quieter layout that makes everything feel a little more intentional.",
      "A few things I’d love for us to explore before Friday:",
      "• Give the reading pane a little more room to breathe.\n• Keep the agent close, but let the email be the main character.\n• Try the softer green as an accent. It feels more like us.",
      "I’ve attached the updated direction with some notes. Would love your eyes on it when you have a moment.",
      "Excited about where this is going.\nSofia",
    ],
  },
  {
    id: 2,
    name: "Marcus from Layers",
    initials: "ML",
    color: "peach",
    subject: "Your kind of people",
    preview: "Alex, meet Elise. I think you two will have a lot to talk about.",
    time: "10:18",
    group: "People",
    unread: true,
    body: [
      "Hey Alex,",
      "I wanted to introduce you to Elise, who’s building a thoughtful little tool for independent designers. Your approach to Monday came up in our conversation.",
      "I think you two will have a lot to talk about. I’ll let you take it from here.",
      "Cheers,\nMarcus",
    ],
  },
  {
    id: 3,
    name: "Linear",
    initials: "L",
    color: "lavender",
    subject: "Your team’s week, in motion",
    preview: "12 issues completed. Here’s what moved forward this week.",
    time: "09:54",
    group: "Updates",
    body: [
      "This week at Monday",
      "Your team completed 12 issues across 3 projects. The new composer is ready for design review and the sync engine has moved into testing.",
      "Next up: keyboard navigation and theme tokens.",
    ],
  },
  {
    id: 4,
    name: "Elena Voss",
    initials: "EV",
    color: "rose",
    subject: "Product designer · a small introduction",
    preview: "I’ve been following Monday and would love to be part of it.",
    time: "09:32",
    group: "Hiring",
    unread: true,
    attachment: "Elena Voss · portfolio.pdf",
    body: [
      "Hi Alex,",
      "I’m Elena, a product designer who cares a lot about the tools we spend our days in. I’ve been following Monday and would love to be part of it.",
      "I spent the last three years working on communication tools and design systems. My portfolio is attached, along with a few thoughts about email.",
      "Thanks for taking a look,\nElena",
    ],
  },
  {
    id: 5,
    name: "Theo Park",
    initials: "TP",
    color: "blue",
    subject: "Coffee, and that thing we talked about",
    preview: "Thursday at the usual place? I have a few ideas for you.",
    time: "Yesterday",
    group: "People",
    body: [
      "Alex,",
      "Thursday at the usual place? I have a few ideas for you about making the local agent experience feel seamless.",
      "Maybe 10? Coffee is on me this time.",
      "Theo",
    ],
  },
  {
    id: 6,
    name: "Vercel",
    initials: "V",
    color: "gray",
    subject: "Monday is ready for the world",
    preview: "Your deployment to monday.design is ready.",
    time: "Yesterday",
    group: "Updates",
    body: [
      "Deployment complete",
      "Your latest preview is ready. Share it with the team for feedback when you have a moment.",
    ],
  },
  {
    id: 7,
    name: "Nora Williams",
    initials: "NW",
    color: "sage",
    subject: "Re: The details make the difference",
    preview: "Yes. Especially the keyboard shortcuts. A few more notes…",
    time: "Yesterday",
    group: "Design partners",
    body: [
      "Absolutely.",
      "Especially the keyboard shortcuts. Moving between messages should feel immediate, and the agent should stay within reach without interrupting reading.",
      "I left a few more notes in the file.\nNora",
    ],
  },
  {
    id: 8,
    name: "Are.na",
    initials: "A",
    color: "peach",
    subject: "A few things worth keeping",
    preview: "New additions to your channel: Interfaces that feel human.",
    time: "Mon",
    group: "Reading list",
    body: [
      "Your weekly collection",
      "There are 8 new additions to Interfaces that feel human. A little inspiration for your next quiet afternoon.",
    ],
  },
];
export const themes = [
  {
    id: "chalk",
    name: "Chalk",
    desc: "Soft whites. A little sage.",
    colors: ["#f5f5f2", "#ffffff", "#507760"],
  },
  {
    id: "ink",
    name: "Ink",
    desc: "Quiet dark. Clear thinking.",
    colors: ["#191b1b", "#252828", "#a8c9ab"],
  },
  {
    id: "nord",
    name: "Nord",
    desc: "Cool slate. Northern light.",
    colors: ["#242c38", "#303b4b", "#8fbcbb"],
  },
  {
    id: "rose",
    name: "Rosé",
    desc: "Warm paper. Muted rose.",
    colors: ["#f8f2f2", "#fffafa", "#9c5968"],
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    desc: "Mocha with a lavender note.",
    colors: ["#1e1e2e", "#313244", "#cba6f7"],
  },
  {
    id: "dune",
    name: "Dune",
    desc: "Sand, stone, and olive.",
    colors: ["#eeeade", "#f8f5ed", "#727449"],
  },
];
