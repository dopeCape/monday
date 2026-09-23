/// <reference types="bun-types" />
// personName through its interface: whatever a Person carries, a row shows a name.

import { describe, expect, test } from "bun:test";
import { personName } from "./format.ts";

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
