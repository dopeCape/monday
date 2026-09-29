// The people a field suggests as the user types (lookup.ts): the Cache's
// matches as soon as they are read, the Server's merged in when they arrive.
// While an answer for the newest keystroke is on its way, the last answer is
// narrowed to what still matches, so the list never shows a stale person.

import type { Person, PersonHit } from "@monday/shared";
import { peopleQueryWords, personMatches } from "@monday/shared";
import { useEffect, useMemo, useState } from "react";
import { createPeopleLookup, type PeopleResult, type PeopleSource } from "./lookup.ts";

export function usePeopleSuggestions(
  source: PeopleSource | undefined,
  query: string,
  chosen: readonly Person[],
): PersonHit[] {
  const lookup = useMemo(() => (source ? createPeopleLookup(source) : null), [source]);
  const [result, setResult] = useState<PeopleResult>({ query: "", people: [], complete: true });
  // A stable key for the chosen addresses, so a new array with the same people asks nothing.
  const chosenKey = chosen.map((p) => p.email.toLowerCase()).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: chosenKey stands for chosen
  useEffect(() => {
    if (!lookup) return;
    lookup.query(query, chosen, setResult);
  }, [lookup, query, chosenKey]);

  useEffect(() => () => lookup?.cancel(), [lookup]);

  return useMemo(() => {
    if (query.trim() === "") return [];
    const taken = new Set(chosen.map((p) => p.email.toLowerCase()));
    const fresh = result.query === query;
    const words = fresh ? null : peopleQueryWords(query);
    return result.people.filter(
      (p) => !taken.has(p.email.toLowerCase()) && (words === null || personMatches(p, words)),
    );
  }, [result, query, chosen]);
}
