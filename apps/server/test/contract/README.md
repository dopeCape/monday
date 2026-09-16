# Provider contract tests

The conformance suite from `test/providers/conformance.ts` against live test
accounts (ADR 0009: "provider contract tests run nightly against live test
accounts"). Every file here skips unless its environment is set, so a plain
`bun test` never touches the network.

| File | Environment | Account |
|---|---|---|
| `jmap.contract.test.ts` | `TEST_JMAP_URL` (session URL, for Fastmail `https://api.fastmail.com/jmap/session`), `TEST_JMAP_TOKEN`, optional `TEST_JMAP_ADDRESS` | A Fastmail account with an API token holding Email and Email submission scopes, or any RFC 8621 server with a bearer token |
| `imap.contract.test.ts` | `TEST_IMAP_HOST`, `TEST_IMAP_USER`, `TEST_IMAP_PASS`, optional `TEST_IMAP_PORT` (993), `TEST_SMTP_HOST` (defaults to the IMAP host with `imap` replaced by `smtp`), `TEST_SMTP_PORT` (465) | A Dovecot, Fastmail or other IMAP account with an app password |

Set `TEST_CONTRACT_SEND=1` to let the suite send one message to the account's
own address. Gmail and Graph contract tests arrive with slice 9 (issue 19
tracks the credentials).

Run one by hand:

```
TEST_JMAP_URL=https://api.fastmail.com/jmap/session TEST_JMAP_TOKEN=... bun test apps/server/test/contract
```

CI runs this directory nightly from `.github/workflows/contract-nightly.yml`
with the same variables as repository secrets.
