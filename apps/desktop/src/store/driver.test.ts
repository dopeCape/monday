// The Tauri driver's packed rows: columns once, values by position, back to objects.

import { describe, expect, test } from "bun:test";
import { unpackRows } from "./driver.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("unpackRows", () => {
  test("rebuilds objects keyed by column name, nulls and text kept", () => {
    const rows = unpackRows(
      bytes({
        c: ["id", "subject", "snoozed_until"],
        r: [
          ["e1", 'Café "quoted"', null],
          ["e2", "", "2026-09-24T10:00:00Z"],
        ],
      }),
    );
    expect(rows).toEqual([
      { id: "e1", subject: 'Café "quoted"', snoozed_until: null },
      { id: "e2", subject: "", snoozed_until: "2026-09-24T10:00:00Z" },
    ]);
  });

  test("no rows is an empty list", () => {
    expect(unpackRows(bytes({ c: ["n"], r: [] }))).toEqual([]);
  });
});
