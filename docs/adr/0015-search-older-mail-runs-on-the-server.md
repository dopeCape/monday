---
status: accepted
supersedes: the "search older mail" part of ADR 0011
---

# "Search older mail" is a full search on the Server, never a copy into the Cache

ADR 0011 made search local: every keystroke is answered from the Cache's FTS5 index, and older mail was reachable through "search older mail", which pulled candidate bodies by date range into the Cache in batches and searched them there. On a real mailbox that meant a click downloaded thousands of bodies onto the laptop before the first result, filled the Cache with mail the user did not ask to keep, and still only searched the range it could afford. The user's verdict: clicking it "fetches the mails, that is stupid; the search should run in the backend over the entire db."

We decided that "Search older mail" runs the query as a **full search** on the Server over the whole mailbox (`POST /search/full`). Typing is unchanged: every keystroke is still answered locally, and nothing on that path calls the Server (ADR 0011 stands for it). Only the explicit click, or the Agent's `search_threads` with `full`, reaches the Server.

How it runs, since bodies are encrypted at rest and the Server keeps no plaintext index:

- The query is parsed with the one shared parser (`packages/shared/src/search-query.ts`), the same the client compiles to FTS5, so operators mean the same on both sides.
- SQL narrows the Threads first on what is in the clear: the Workspace, not in the trash, dates, `is:unread`, `is:starred`, `has:attachment`, `in:`, `tag:`, `label:`, and `from:` and `to:` as substrings of the Messages' addresses.
- The Threads left are walked newest first in pages (`search.full_page_size`), with `search.full_concurrency` pages read from Postgres at once. Each Thread is matched by the shared plaintext matcher (`search-match.ts`, the Cache index's rules: unicode61 tokens, prefix words, phrases, per-Message AND, negations, the trigram pass). Subjects and bodies are decrypted lazily, in memory, only when a term reaches them, and dropped with the page.
- Hits stream back as NDJSON (`hit`, `progress` with a resume cursor, `done`), newest first. The stream stops at `search.full_limit` hits with a cursor; "Search further" resumes below it. Closing the request stops the scan.
- The client merges the hits into the local ones (each Thread once, newest first) and writes nothing to the Cache. Opening a hit is opening any Thread outside the window: its header is in the Cache, its body is fetched on open.

Measured on a synthetic encrypted mailbox (`apps/server/test/full-search.bench.ts`, a 16-thread laptop under other load, embedded Postgres): 56,000 Threads, 95,200 Messages, 476 MB of body ciphertext. A rare word (in 20 Threads) is the worst case: every subject and body is decrypted (151,200 envelopes), and the whole mailbox is scanned in 4.6 s at the defaults (500 Threads per page, 3 pages read at once; 5.2 s with Postgres cold). One page at a time takes 6.7 s, 250 per page 6.4 s, 1,000 per page 4.3 s. A clear filter decrypts only what it leaves: `from:` over one sender's 2,239 Threads in 0.3 s, `is:unread` over 8,000 in 0.75 s. A common word fills the first 100 results in 70 ms.

## Considered options

- Keep pulling bodies into the Cache. Rejected: the user's objection above; slow to first result, and it spends the Cache's space on mail nobody asked to keep.
- A plaintext full-text index on the Server (Postgres tsvector over bodies). Rejected: it would store the mailbox's text in the clear next to the ciphertext and defeat encryption at rest (research 5).
- An encrypted or blinded index (per-token HMACs). Rejected for v1: it leaks term frequencies, cannot do prefix or phrase matching without a much larger design, and the linear scan is already fast enough.
- Decrypt in worker threads. Deferred: the scan is bound by reading from Postgres as much as by AES-GCM, and the Server stays runtime-neutral (Vercel, Netlify); the page and concurrency Settings are the knobs.

## Consequences

- Plaintext passes through the Server's memory during an explicit full search, on a Cloud as on the Sidecar. That is acceptable: it is the user's own Server, which already decrypts every body it serves to the reader, the search runs only on the user's explicit action (or an Agent tool call they started), and nothing decrypted is written anywhere or kept after the page. A locked Server answers 423 before anything streams.
- The Server holds no search index of body text; the headers index (`/search/headers`) is unchanged.
- The bulk body route stays for the pre-warm Job alone; `search.older_batch` and its strings are gone.
- The Agent's `search_threads` takes `full` for questions about older mail or words inside messages, and runs the same scan through the same Mailstore call as the route.
- ADR 0011's "Older mail is reachable through an explicit 'search older mail' that pulls candidate bodies by date range into the Cache" is replaced by this ADR; the rest of ADR 0011 stands.
