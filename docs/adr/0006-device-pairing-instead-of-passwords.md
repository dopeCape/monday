---
status: accepted
---

# A single-user Server authenticates devices by pairing, not passwords

A Cloud server has exactly one owner, so the question is device trust, not identity. We decided there is no password. The first device enters a one-time setup code the install produces; every later device is approved from an existing device with a short code, after which the Server mints a long-lived per-device token kept in the OS keychain. A passkey registered at setup, or a new setup code from the host, is the recovery path. The Sidecar accepts its own client on loopback with a loopback token; since ADR 0013 that token is stable across launches (kept in the keychain, read by the background service from a 0600 file) rather than per launch.

## Considered options

- A password set at install. Rejected: phishable, and ends up in a dotfile.
- Third-party OAuth login. Rejected: a self-hosted server should not depend on GitHub or Google to let its owner in.

## Consequences

- Devices are listed and revocable in Settings; revoking one invalidates its token and its Cache key.
- HTTPS is required off loopback. The container ships automatic certificates; self-signed is pinned on first pairing; plain HTTP is allowed only on private networks behind an explicit, persistent warning.
- The external MCP key path (ticket 29) is a second credential type on the same Server, never a reuse of a device token.
