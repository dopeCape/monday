// The onboarding conversation as the design mock shows it, on the fake Agent
// client: what the browser dev server renders for `?screen=onboarding&step=chat`
// (the pixel diff against design/#/onboarding/chat) where no Server exists.

import { type FakeAgentClient, fakeAgentClient, toolEvent } from "../agent/client.ts";

export const ONBOARDING_FIXTURE_SENDERS = ["Aoife Brennan", "Kenji Watanabe", "Sofia Lindqvist"];

/** The mock's transcript: the whole conversation streams from the kickoff turn. */
export function onboardingFixtureClient(now: () => Date): FakeAgentClient {
  return fakeAgentClient({
    workspaceId: "ws-1",
    now,
    turns: [
      () => [
        toolEvent({ id: "c-ctx", tool: "onboarding_context", status: "done" }),
        { kind: "text", id: "t1", text: "Who are you and what do you do?" },
        { kind: "user", id: "u2", text: "I run a small studio with two people." },
        { kind: "text", id: "t2", text: "What mail matters most to you?" },
        { kind: "user", id: "u3", text: "Aoife Brennan, Kenji Watanabe" },
        { kind: "text", id: "t3", text: "Which tools do you use: Slack, Notion, Drive, Discord?" },
        { kind: "user", id: "u4", text: "Drive" },
        { kind: "text", id: "t4", text: "May monday learn your voice from your sent mail?" },
        { kind: "user", id: "u5", text: "Skip" },
        {
          kind: "text",
          id: "t5",
          text: "May monday read the last 30 days of mail to propose Groups?",
        },
        { kind: "user", id: "u6", text: "Yes" },
        { kind: "text", id: "t6", text: "Here is what I would set up." },
        toolEvent(
          {
            id: "c-groups",
            tool: "propose_groups",
            tier: "reversible",
            inputSummary: "Hiring, Finance, Investors",
            status: "waiting",
          },
          {
            kind: "groups",
            groups: [
              {
                name: "Hiring",
                sentence: "Candidates, recruiters and interview threads.",
                moves: 6,
              },
              { name: "Finance", sentence: "Invoices, receipts and payment notices.", moves: 2 },
              { name: "Investors", sentence: "Mail from Meridian and the other funds.", moves: 3 },
            ],
            considered: 50,
          },
        ),
      ],
    ],
  });
}
