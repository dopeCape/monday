---
status: accepted
---

# Search runs on the client index and never waits on the network or a model

The user's criterion for search was speed. We decided that every keystroke is answered from the client's SQLite FTS5 index with locally parsed Gmail-style operators, and that nothing in that path calls the Server or a model. The Cache is pre-warmed in the background, newest first, with bodies for the last two years within the size cap, on unmetered network and mains power, so the local index covers almost every search. Older mail is reachable through an explicit "Search older mail", which runs the same query as a full search on the Server over the whole mailbox and pulls nothing into the Cache (ADR 0015; it replaced the earlier design that pulled candidate bodies by date range into the Cache). Judgment queries are one Tab away: the Agent runs search as a tool with the same operators.

## Considered options

- Server-side search over decrypted bodies. Rejected for every query: sends plaintext through the Server on each keystroke and is slower than a local index. Accepted later for the explicit "Search older mail" only (ADR 0015).
- Natural language through the model on every search. Rejected: waits on a model call.
- No pre-warm, 90 days only. Rejected: old threads would always wait on the network.

## Consequences

- The Cache window for bodies rises from 90 days to two years when the pre-warm conditions hold; the ADR 0005 defaults remain the floor.
- The command palette shares the same input and the same local matching, so "go to settings" and "from:kenji" both return under 50 ms.
- Cross-workspace reads exist in exactly one place: the "search all accounts" toggle.
