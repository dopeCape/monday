// Candidates for a View's Extractions (docs/spec/views.md, "Extractions:
// select, don't generate"): code over-finds the spans of each kind with the
// words around them and normalizes each, so Jev only ever picks one.

import { describe, expect, test } from "bun:test";
import {
  type CandidateInput,
  extractKindOf,
  findCandidates,
  findDates,
  findReferences,
} from "../src/intelligence/signals/candidates.ts";

const owner = { name: "Sam Okafor", email: "sam@monday.test" };

function input(
  text: string,
  from = { name: "Amazon.com", email: "orders@amazon.com" },
): CandidateInput {
  return {
    messages: [{ from, to: [owner], cc: [], date: "2026-10-02T09:00:00Z", text }],
    owner: owner.email,
    written: "2026-10-02T09:00:00Z",
    dateOrder: "mdy",
  };
}

describe("candidates", () => {
  test("money: every amount with its words around it, normalized to a value and a currency", () => {
    const found = findCandidates(
      "money",
      input(
        "Subtotal: $1,200.00\nSales tax: $115.50\nTotal due: $1,315.50\nA €50,00 credit was applied.",
      ),
      20,
    );
    expect(found.map((c) => c.key)).toEqual(["$1,200.00", "$115.50", "$1,315.50", "€50,00"]);
    expect(found[2]?.value).toEqual({ value: 1315.5, currency: "USD" });
    expect(found[2]?.line).toContain("Total due: $1,315.50");
    expect(found[3]?.value).toEqual({ value: 50, currency: "EUR" });
  });

  test("money: rupees written as ₹, INR or Rs.", () => {
    const found = findCandidates(
      "money",
      input("Bag Total Rs. 1,299.00\nDiscount Rs 500\nShipping ₹ 49\nOrder Total\n848 INR"),
      20,
    );
    expect(found.map((c) => c.value)).toEqual([
      { value: 1299, currency: "INR" },
      { value: 500, currency: "INR" },
      { value: 49, currency: "INR" },
      { value: 848, currency: "INR" },
    ]);
    // Not a currency inside a word ("Hers 20").
    expect(findCandidates("money", input("Hers 20 pieces"), 20)).toEqual([]);
  });

  test("dates: written forms to YYYY-MM-DD, the year nearest the Message, day and month by the setting", () => {
    const text =
      "Arriving Tue, Oct 7. Your return window closes 6 November 2026. Invoice date 2026-09-30, due 10/03/2026.";
    expect(
      findDates(text, "2026-10-02T09:00:00Z", "mdy", 20).map((d) => [d.span, d.value]),
    ).toEqual([
      ["Tue, Oct 7", "2026-10-07"],
      ["6 November 2026", "2026-11-06"],
      ["2026-09-30", "2026-09-30"],
      ["10/03/2026", "2026-10-03"],
    ]);
    expect(findDates("due 10/03/2026", "2026-10-02T09:00:00Z", "dmy", 5)[0]?.value).toBe(
      "2026-03-10",
    );
    // No year, and it has passed by a few days: still this year, the nearest.
    expect(findDates("Ordered on Sep 28.", "2026-10-02T09:00:00Z", "mdy", 5)[0]?.value).toBe(
      "2026-09-28",
    );
    // Not a day: 31 February is no candidate.
    expect(findDates("Feb 31", "2026-10-02T09:00:00Z", "mdy", 5)).toEqual([]);
  });

  test("references: named as one nearby, or a marketplace order number", () => {
    const refs = findReferences(
      "Order #113-4567890-1234567 placed. Invoice No. INV-2291. Booking reference: XKQ7PL. Call 555 now.",
      10,
    ).map((r) => r.value);
    expect(refs).toContain("113-4567890-1234567");
    expect(refs).toContain("INV-2291");
    expect(refs).toContain("XKQ7PL");
    expect(refs).not.toContain("555");
  });

  test("links are numbered with where they go; tracking numbers only near a word about shipping", () => {
    const links = findCandidates(
      "link",
      input("Track it: https://track.amazon.com/x2 or see https://www.amazon.com/orders"),
      5,
    );
    expect(links.map((l) => [l.key, l.line])).toEqual([
      ["l1", "track.amazon.com/x2"],
      ["l2", "www.amazon.com/orders"],
    ]);
    expect(links[0]?.value).toEqual({
      url: "https://track.amazon.com/x2",
      domain: "track.amazon.com",
    });
    expect(
      findCandidates("tracking", input("Your package 1Z999AA10123456784 shipped."), 5)[0]?.value,
    ).toBe("1Z999AA10123456784");
    expect(findCandidates("tracking", input("Call 1Z999AA10123456784"), 5)).toEqual([]);
  });

  test("people, companies, quantities, items and sentences", () => {
    const text =
      "Hi Sam,\n\n- 2 x Desk lamp $40.00\n- Qty: 1 USB cable $9.99\nNorthwind Traders Inc. will ship it.\n\nThanks,\nAoife Brennan";
    const i = input(text, { name: "Aoife Brennan", email: "aoife@northwind.com" });
    expect(findCandidates("person", i, 10).map((c) => c.value)).toContain("Aoife Brennan");
    const companies = findCandidates("company", i, 10).map((c) => c.value);
    expect(companies).toContain("Northwind Traders Inc");
    expect(companies).toContain("Northwind");
    expect(findCandidates("quantity", i, 10).map((c) => c.value)).toEqual([2, 1]);
    expect(findCandidates("item", i, 10).map((c) => c.value)).toEqual([
      "2 x Desk lamp $40.00",
      "Qty: 1 USB cable $9.99",
    ]);
    const mine = input("Sure. I will send the signed copy by Friday. Talk soon.", owner);
    expect(findCandidates("sentence", mine, 10).map((c) => c.value)).toContain(
      "I will send the signed copy by Friday.",
    );
  });

  test("items: the products on an Amazon.in order, never its quantity or its prices", () => {
    // The text part of a real Amazon.in confirmation, the shape a session read nothing from.
    const amazonIn = [
      "Hello Sam,",
      "Thank you for your order. We'll send a confirmation when your items ship.",
      "",
      "Order #408-1234567-7654321",
      "",
      "* Kérastase Gloss Absolu Anti-Frizz Shampoo For Bouncy, Glossy Hair | With Glycerin & Hydrolyzed Rice Protein | Nourishes & Smoothens Frizzy Hair | Adds Shine | 250ml",
      "  Quantity: 1",
      "  2900 INR",
      "",
      "* Philips BHS386 Kerashine Hair Straightener",
      "  Quantity: 2",
      "  1,899 INR",
      "",
      "Shipping & Handling",
      "5 INR",
      "",
      "Total",
      "2905 INR",
    ].join("\n");
    const items = findCandidates("item", input(amazonIn), 20).map((c) => c.value);
    expect(items).toEqual([
      "Kérastase Gloss Absolu Anti-Frizz Shampoo For Bouncy, Glossy Hair | With Glycerin & Hydrolyzed Rice Protein | Nourishes & Smoothens Frizzy Hair | Adds Shine | 250ml",
      "Philips BHS386 Kerashine Hair Straightener",
    ]);
    // The money finder still finds every amount for the order total.
    expect(findCandidates("money", input(amazonIn), 20).map((c) => c.key)).toEqual([
      "2900 INR",
      "1,899 INR",
      "5 INR",
      "2905 INR",
    ]);
  });

  test("items: Myntra and H&M receipts, with attributes under each product", () => {
    const myntra = [
      "Your order is confirmed!",
      "Item Details",
      "Roadster Men Blue Slim Fit Casual Shirt",
      "Size: M",
      "Qty: 1",
      "Rs. 799",
      "HRX by Hrithik Roshan Running Shoes",
      "Size: UK 9",
      "Qty: 1",
      "Rs. 2,499",
      "Bag Total Rs. 3,298",
      "Discount -Rs. 500",
      "Order Total Rs. 2,798",
    ].join("\n");
    expect(findCandidates("item", input(myntra), 20).map((c) => c.value)).toEqual([
      "Roadster Men Blue Slim Fit Casual Shirt",
      "HRX by Hrithik Roshan Running Shoes",
    ]);
    const hm = [
      "Thank you for shopping at H&M",
      "",
      "Relaxed Fit Printed T-shirt",
      "Art. No.: 0987654001",
      "Color: White/Snoopy",
      "Size: L",
      "Quantity: 1",
      "Price: Rs. 1,299.00",
      "",
      "2x Ribbed Socks, 5-pack   Rs. 1,198.00",
      "",
      "Subtotal: Rs. 2,497.00",
      "Delivery: Rs. 0.00",
      "Total: Rs. 2,497.00",
    ].join("\n");
    expect(findCandidates("item", input(hm), 20).map((c) => c.value)).toEqual([
      "Relaxed Fit Printed T-shirt",
      "2x Ribbed Socks, 5-pack   Rs. 1,198.00",
    ]);
    // A line longer than the Setting is not offered.
    const long = `* ${"Very long product name ".repeat(20)}\n  Quantity: 1`;
    expect(findCandidates("item", { ...input(long), itemChars: 100 }, 20)).toEqual([]);
  });

  test("an Extraction's kind from its option source", () => {
    expect(extractKindOf("extract:money")).toBe("money");
    expect(extractKindOf("amounts")).toBeNull();
  });
});
