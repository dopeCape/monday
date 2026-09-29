// Recipients as pills with an input and an autocomplete over the people
// index (src/people): the Cache's matches at once, the Server's over the whole
// mailbox merged in when they arrive. Enter, Tab, comma or blur turn the
// typed text into a pill; pasting several addresses makes a pill of each;
// Backspace on an empty input removes the last one; arrows walk the
// suggestions. The classes are the mock's (.pill inside .c-field).

import type { Person } from "@monday/shared";
import { personName } from "@monday/ui";
import { type ClipboardEvent, type KeyboardEvent, useId, useState } from "react";
import { highlightSpans } from "../../people/highlight.ts";
import type { PeopleSource } from "../../people/lookup.ts";
import { usePeopleSuggestions } from "../../people/usePeople.ts";
import { parseRecipient } from "./reply.ts";

export interface RecipientsProps {
  value: readonly Person[];
  onChange: (people: Person[]) => void;
  /** Who the autocomplete offers; none means no suggestions. */
  source?: PeopleSource | undefined;
  label: string;
  autofocus?: boolean | undefined;
  /** Rendered after the input: the Cc and Bcc toggles on the To row. */
  trailing?: React.ReactNode | undefined;
  onBlur?: (() => void) | undefined;
  inputId?: string | undefined;
}

/**
 * The people in a list whose name or address contains the query, excluding
 * those already chosen, in list order; at most eight. For a directory already
 * in hand (the calendar's guests when no people index is given).
 */
export function suggest(
  people: readonly Person[],
  query: string,
  chosen: readonly Person[],
  limit = 8,
): Person[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const taken = new Set(chosen.map((p) => p.email.toLowerCase()));
  const out: Person[] = [];
  for (const p of people) {
    if (taken.has(p.email.toLowerCase())) continue;
    if (p.email.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Several recipients pasted at once ("a@x.io, B <b@y.io>; c@z.io"), or null when it is not a list of them. */
export function parseRecipientList(text: string): Person[] | null {
  const parts = text
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const out: Person[] = [];
  for (const part of parts) {
    const p = parseRecipient(part);
    if (!p) return null;
    if (!out.some((o) => o.email.toLowerCase() === p.email.toLowerCase())) out.push(p);
  }
  return out;
}

/** A name or address with the typed part marked. */
export function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSpans(text, query).map((s, i) =>
        s.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reorder
          <mark key={i}>{s.text}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reorder
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export function Recipients({
  value,
  onChange,
  source,
  label,
  autofocus,
  trailing,
  onBlur,
  inputId,
}: RecipientsProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const generated = useId();
  const id = inputId ?? generated;
  const suggestions = usePeopleSuggestions(source, query, value);
  // The Server's answer can shorten the list while an arrow is down it: keep the cursor on it.
  const at = Math.min(cursor, Math.max(0, suggestions.length - 1));

  const add = (p: Person) => {
    if (value.some((v) => v.email.toLowerCase() === p.email.toLowerCase())) return;
    onChange([...value, { name: p.name, email: p.email }]);
    setQuery("");
    setCursor(0);
  };
  const addAll = (people: readonly Person[]) => {
    const have = new Set(value.map((v) => v.email.toLowerCase()));
    const fresh = people.filter((p) => !have.has(p.email.toLowerCase()));
    if (fresh.length > 0) onChange([...value, ...fresh]);
    setQuery("");
    setCursor(0);
  };
  const remove = (email: string) => onChange(value.filter((v) => v.email !== email));
  const commit = (): boolean => {
    const picked = suggestions[at];
    if (picked) {
      add(picked);
      return true;
    }
    const parsed = parseRecipient(query);
    if (parsed) {
      const known = suggestions.find((p) => p.email.toLowerCase() === parsed.email.toLowerCase());
      add(parsed.name || !known ? parsed : known);
      return true;
    }
    return false;
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const list = parseRecipientList(`${query}${e.clipboardData.getData("text")}`);
    if (!list) return;
    e.preventDefault();
    addAll(list);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      if (query.trim() === "") return;
      if (commit()) e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && query === "" && value.length > 0) {
      const last = value[value.length - 1];
      if (last) remove(last.email);
      return;
    }
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setCursor((c) => (c + 1) % suggestions.length);
      return;
    }
    if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setCursor((c) => (c - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      setQuery("");
    }
  };

  return (
    <div className="to">
      {value.map((p) => (
        <span key={p.email} className="pill" title={p.email}>
          {personName(p)}
          <button
            type="button"
            className="x"
            aria-label={`${label}: ${p.email}`}
            onClick={() => remove(p.email)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={label}
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: the compose surface opens on the empty field
        autoFocus={autofocus}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (query.trim() !== "") commit();
          onBlur?.();
        }}
      />
      {trailing}
      {suggestions.length > 0 ? (
        <div className="c-suggest" role="listbox">
          {suggestions.map((p, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === at}
              key={p.email}
              className={`pop-item${i === at ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(p)}
            >
              <span>
                <Marked text={personName(p)} query={query} />
              </span>
              {p.name.trim() ? (
                <span>
                  <Marked text={p.email} query={query} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
