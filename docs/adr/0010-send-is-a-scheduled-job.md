---
status: accepted
---

# Sending is a scheduled Job, so undo send and send later are the same mechanism

Sending mail is the one action with no undo at the provider. We decided that pressing Send never sends: it enqueues a send Job with a delay (default 30 seconds) and shows an Undo bar. Undo cancels the Job and reopens the Draft. Send later is the same Job with a later time. The Job runs on whichever Server is alive, so a scheduled send goes out with the laptop closed when a Cloud exists. Drafts are Server-owned records mirrored into the provider's Drafts folder, saved through the Store like any other intent.

## Considered options

- Immediate send with no undo. Rejected: the only irreversible action in the product would have no safety net.
- Undo only while the client is open. Rejected: send later would need the laptop awake.
- Device-local drafts. Rejected: lost with the device, invisible to other clients.

## Consequences

- The Outbox intent for send is "schedule a send Job", never "send", so offline sends also enter the undo window when they reach the Server.
- Transport is per provider: Gmail send API, Graph sendMail, JMAP EmailSubmission, SMTP for IMAP with APPEND to Sent unless the provider copies it.
- The delay is a Setting; zero means immediate. The Activity log records every send with the Job id.
