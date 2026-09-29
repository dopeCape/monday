// The Template form's pure parts: the Placeholders follow the text as it is
// typed (every {name} used is declared, keeping what the user already said
// about it), and a new name gets the type its name suggests.

import type { Placeholder, PlaceholderType, TemplateInput } from "@monday/shared";
import { templateUses } from "@monday/shared";

/** The type a Placeholder's name suggests: {first_name} a first name, {due_date} a date. */
export function guessType(name: string): PlaceholderType {
  if (name === "first_name" || name.endsWith("_first_name")) return "first_name";
  if (/(^|_)(email|address)$/.test(name)) return "email";
  if (/(^|_)(date|day|deadline)$/.test(name)) return "date";
  if (/(^|_)time$/.test(name)) return "time";
  if (/(^|_)(amount|price|total|fee)$/.test(name)) return "amount";
  if (/(^|_)(link|url)$/.test(name)) return "link";
  if (/(^|_)(reference|invoice_number|order_number|ticket|number)$/.test(name)) {
    return name === "number" ? "number" : "reference";
  }
  if (/(^|_)(person|colleague|name)$/.test(name)) return "person";
  return "text";
}

/** The Placeholders the subject and body use now, in order, each keeping its earlier type and hint. */
export function placeholdersFor(
  input: Pick<TemplateInput, "subject" | "body">,
  previous: readonly Placeholder[],
): Placeholder[] {
  const known = new Map(previous.map((p) => [p.name, p]));
  return templateUses(input).map((u) => {
    const p = known.get(u.name);
    return p
      ? { ...p, optional: u.optional }
      : { name: u.name, type: guessType(u.name), optional: u.optional, hint: "" };
  });
}

/** A blank Template for the New button. */
export function blankTemplate(): TemplateInput {
  return {
    name: "",
    fitsWhen: "",
    kind: "reply",
    subject: null,
    body: "Hi {first_name},\n\n",
    placeholders: [
      { name: "first_name", type: "first_name", optional: false, hint: "their first name" },
    ],
  };
}
