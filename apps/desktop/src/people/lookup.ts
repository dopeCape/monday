// People as they are typed (packages/shared people.ts): the Cache answers at
// once, the Server's index over the whole mailbox a moment later, and the two
// are merged into one ranked list, one row per address.
//
// A PeopleSource is where the answers come from; the composer builds one over
// its Store and the Server (store-composer.ts), tests build their own. A
// lookup runs one query at a time: every new query drops the one before, its
// pending Server request is aborted, and an answer that arrives for an old
// query is ignored. The Server is asked only after typing pauses for the
// people.server_debounce_ms Setting, and not at all when people.search_server
// is off, the Server is unreachable, or there is none: the Cache's answer
// stands alone.

import type { Person, PersonHit } from "@monday/shared";
import { mergePeople, peopleQueryWords, personMatches } from "@monday/shared";

export interface PeopleSource {
  /** The Cache's matches, ranked. */
  local(q: string, limit: number): Promise<PersonHit[]>;
  /** The Server's, ranked; null when it is not to be asked. Rejects offline. */
  remote?(q: string, limit: number, signal: AbortSignal): Promise<PersonHit[] | null>;
  /** The most people shown (people.suggestions). */
  limit(): number;
  /** The pause before asking the Server, in ms (people.server_debounce_ms). */
  debounceMs(): number;
}

export interface PeopleResult {
  /** The query this answers, as typed. */
  query: string;
  people: PersonHit[];
  /** Whether the Server's answer is in (or will not come). */
  complete: boolean;
}

export interface PeopleLookup {
  /** Starts a query; `onResult` hears the Cache's answer, then the merged one. */
  query(q: string, exclude: readonly Person[], onResult: (result: PeopleResult) => void): void;
  /** Drops the current query and any request in flight. */
  cancel(): void;
}

export function createPeopleLookup(source: PeopleSource): PeopleLookup {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const stop = () => {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  return {
    query(q, exclude, onResult) {
      stop();
      const mine = generation;
      const query = q;
      const limit = Math.max(1, source.limit());
      const skip = exclude.map((p) => p.email);
      // Excluded people are dropped after the fact, so ask for enough to fill the list.
      const ask = limit + skip.length;
      if (q.trim() === "") {
        onResult({ query, people: [], complete: true });
        return;
      }
      let local: PersonHit[] = [];
      let server: PersonHit[] | null = null;
      let serverDone = !source.remote;
      const emit = () => {
        if (mine !== generation) return;
        onResult({ query, people: mergePeople(local, server, skip, limit), complete: serverDone });
      };
      source.local(q, ask).then(
        (rows) => {
          local = rows;
          emit();
        },
        () => emit(),
      );
      const remote = source.remote?.bind(source);
      if (!remote) return;
      const ask2 = () => {
        if (mine !== generation) return;
        const c = new AbortController();
        controller = c;
        remote(q, ask, c.signal).then(
          (rows) => {
            if (mine !== generation || c.signal.aborted) return;
            server = rows;
            serverDone = true;
            emit();
          },
          () => {
            // Offline, locked or no such route: the Cache's answer stands.
            if (mine !== generation || c.signal.aborted) return;
            serverDone = true;
            emit();
          },
        );
      };
      const wait = Math.max(0, source.debounceMs());
      timer = setTimeout(ask2, wait);
    },
    cancel: stop,
  };
}

/**
 * A source over a list already in hand, most recent first, for the fixture
 * composer and the calendar's own directory: no Cache query, no Server.
 */
export function listSource(
  people: () => readonly Person[],
  limit: () => number = () => 8,
): PeopleSource {
  return {
    async local(q, max) {
      const words = peopleQueryWords(q);
      const all = people();
      const out: PersonHit[] = [];
      all.forEach((p, i) => {
        if (!personMatches(p, words)) return;
        out.push({ ...p, sent: 0, received: 0, lastAt: null, score: all.length - i });
      });
      return out.slice(0, max);
    },
    limit,
    debounceMs: () => 0,
  };
}

/**
 * A source with a list folded into its Cache answer: the source's people
 * first, by score, then the list's that it did not find (the calendar's
 * guests from earlier Events), in list order. The Server is asked as before.
 */
export function withList(source: PeopleSource, list: () => readonly Person[]): PeopleSource {
  const extra = listSource(list);
  return {
    ...source,
    async local(q, limit) {
      const [found, listed] = await Promise.all([source.local(q, limit), extra.local(q, limit)]);
      const have = new Set(found.map((p) => p.email.toLowerCase()));
      const floor = Math.min(0, ...found.map((p) => p.score));
      const rest = listed
        .filter((p) => !have.has(p.email.toLowerCase()))
        .map((p, i) => ({ ...p, score: floor - 1 - i }));
      return [...found, ...rest].slice(0, limit);
    },
  };
}
