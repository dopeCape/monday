/// <reference types="bun-types" />
// personName through its interface: whatever a Person carries, a row shows a name.
// The list and header dates: a date in an earlier calendar year shows its year.

import { describe, expect, test } from "bun:test";
import { formatListTime, formatWhen, personName } from "./format.ts";

describe("the year in a list date", () => {
  // Local times, so the rule is read in the user's own calendar.
  const now = new Date(2026, 8, 28, 15, 0);
  const at = (y: number, m: number, d: number, h = 9, min = 41) =>
    new Date(y, m, d, h, min).toISOString();

  test("today keeps its time", () => {
    expect(formatListTime(at(2026, 8, 28), now)).toBe("09:41");
    expect(formatWhen(at(2026, 8, 28), now)).toBe("Today 09:41");
  });

  test("this year shows no year", () => {
    expect(formatListTime(at(2026, 8, 27), now)).toBe("Yesterday");
    expect(formatListTime(at(2026, 8, 24), now)).toBe("Thu");
    expect(formatListTime(at(2026, 2, 12), now)).toBe("Mar 12");
    expect(formatListTime(at(2026, 0, 1, 0, 5), now)).toBe("Jan 1");
    expect(formatWhen(at(2026, 2, 12, 16, 0), now)).toBe("Mar 12 16:00");
  });

  test("last year and older show the year", () => {
    expect(formatListTime(at(2025, 2, 12), now)).toBe("Mar 12, 2025");
    expect(formatListTime(at(2025, 11, 31, 23, 59), now)).toBe("Dec 31, 2025");
    expect(formatListTime(at(2019, 5, 3), now)).toBe("Jun 3, 2019");
    expect(formatWhen(at(2025, 2, 12, 16, 0), now)).toBe("Mar 12, 2025 16:00");
  });

  test("across the year boundary, last night carries last year", () => {
    const newYear = new Date(2027, 0, 1, 8, 0);
    expect(formatListTime(at(2026, 11, 31, 22, 0), newYear)).toBe("Dec 31, 2026");
    expect(formatWhen(at(2026, 11, 31, 22, 0), newYear)).toBe("Dec 31, 2026 22:00");
    expect(formatListTime(at(2027, 0, 1, 0, 30), newYear)).toBe("00:30");
  });
});

describe("personName", () => {
  test("a person's own name wins", () => {
    expect(personName({ name: "Aoife Byrne", email: "ab@northwind.dev" })).toBe("Aoife Byrne");
    expect(personName({ name: '  "Aoife Byrne"  ', email: "ab@northwind.dev" })).toBe(
      "Aoife Byrne",
    );
  });

  test("an empty name falls back to the dotted local part, prettified", () => {
    expect(personName({ name: "", email: "aoife.byrne@x.dev" })).toBe("Aoife Byrne");
    expect(personName({ name: "   ", email: "mateus_silva@x.dev" })).toBe("Mateus Silva");
    expect(personName({ name: "", email: "JEAN-luc.picard+news@x.dev" })).toBe("Jean Luc Picard");
    // A name that is only the address again counts as none.
    expect(personName({ name: "aoife.byrne@x.dev", email: "aoife.byrne@x.dev" })).toBe(
      "Aoife Byrne",
    );
  });

  test("a local part that does not read like a name stays as written", () => {
    expect(personName({ name: "", email: "noreply@github.com" })).toBe("noreply");
    expect(personName({ name: "", email: "billing2@stripe.com" })).toBe("billing2");
    expect(personName({ name: "", email: "no.reply.42@x.dev" })).toBe("no.reply.42");
  });

  test("an address-only person with no local part shows the address, and nothing shows the fallback", () => {
    expect(personName({ email: "@x.dev" })).toBe("@x.dev");
    expect(personName({ name: "", email: "" }, "Unknown sender")).toBe("Unknown sender");
    expect(personName(undefined, "Unknown sender")).toBe("Unknown sender");
    expect(personName({ email: "plain" })).toBe("plain");
  });
});
