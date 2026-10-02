import { describe, expect, test } from "bun:test";
import { type AttachRequest, composerAttach } from "./mentions.tsx";

const reply = (id: string): AttachRequest => ({ id, type: "reply", label: `Reply: ${id}` });

describe("the composer attach bus", () => {
  test("a chip reaches only its own Workspace's composers, though every warmed Account stays mounted", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = composerAttach.listen("ws-a", (items) => a.push(...items.map((i) => i.id)));
    const offB = composerAttach.listen("ws-b", (items) => b.push(...items.map((i) => i.id)));
    composerAttach.attach("ws-a", [reply("t1")]);
    expect(a).toEqual(["t1"]);
    expect(b).toEqual([]);
    offA();
    offB();
  });

  test("with no composer of that Workspace mounted the chip waits for one, and only that one", () => {
    composerAttach.attach("ws-c", [reply("t2")]);
    const other: string[] = [];
    const offOther = composerAttach.listen("ws-d", (items) =>
      other.push(...items.map((i) => i.id)),
    );
    expect(other).toEqual([]);
    const mine: string[] = [];
    const offMine = composerAttach.listen("ws-c", (items) => mine.push(...items.map((i) => i.id)));
    expect(mine).toEqual(["t2"]);
    offOther();
    offMine();
  });
});
