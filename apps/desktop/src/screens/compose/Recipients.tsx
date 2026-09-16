// Recipients as pills with an input and an autocomplete over the Cache's
// participants. Enter, Tab, comma or blur turn the typed text into a pill;
// Backspace on an empty input removes the last one; arrows walk the
// suggestions. The classes are the mock's (.pill inside .c-field).

import type { Person } from "@monday/shared";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { parseRecipient } from "./reply.ts";

export interface RecipientsProps {
  value: readonly Person[];
  onChange: (people: Person[]) => void;
  /** Who the autocomplete offers, most recent first. */
  people: readonly Person[];
  label: string;
  autofocus?: boolean | undefined;
  /** Rendered after the input: the Cc and Bcc toggles on the To row. */
  trailing?: React.ReactNode | undefined;
  onBlur?: (() => void) | undefined;
  inputId?: string | undefined;
}

/** The people matching a query, excluding those already chosen; at most eight. */
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

export function Recipients({
  value,
  onChange,
  people,
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
  const suggestions = useMemo(() => suggest(people, query, value), [people, query, value]);

  const add = (p: Person) => {
    if (value.some((v) => v.email.toLowerCase() === p.email.toLowerCase())) return;
    onChange([...value, p]);
    setQuery("");
    setCursor(0);
  };
  const remove = (email: string) => onChange(value.filter((v) => v.email !== email));
  const commit = (): boolean => {
    const picked = suggestions[cursor];
    if (picked) {
      add(picked);
      return true;
    }
    const parsed = parseRecipient(query);
    if (parsed) {
      const known = people.find((p) => p.email.toLowerCase() === parsed.email.toLowerCase());
      add(known ?? parsed);
      return true;
    }
    return false;
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
          {p.name || p.email}
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
              aria-selected={i === cursor}
              key={p.email}
              className={`pop-item${i === cursor ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(p)}
            >
              <span>{p.name || p.email}</span>
              {p.name ? <span>{p.email}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
