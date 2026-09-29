// The Reply chip named by the on-open suggestion: only the reply chip changes.

import { describe, expect, test } from "bun:test";
import type { BriefAction } from "@monday/shared";
import { nameReplyChip } from "./reply.ts";

describe("nameReplyChip", () => {
  const chips: BriefAction[] = [
    { kind: "reply", label: "Reply", proposedLine: "" },
    { kind: "archive", label: "Archive" },
  ];
  test("names the Reply chip with the Template, leaves the rest", () => {
    const named = nameReplyChip(
      chips,
      { threadId: "t1", templateId: "t_confirm_time", name: "Confirm the time" },
      "Reply with {name}",
    );
    expect(named.map((c) => c.label)).toEqual(["Reply with Confirm the time", "Archive"]);
    expect(nameReplyChip(chips, null, "Reply with {name}")).toEqual(chips);
  });
});
