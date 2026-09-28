# Workflows page behavior

Behaviors a tester can check. The document, its schema and the run engine are ADR 0003; tiers and approvals are ADR 0002; every default is a Setting (ADR 0004) and every word a `strings.workflows.*` Setting.

## Locked by the AI level

- Workflows run only at the AI level "Mail that sorts and acts for me" (`ai.level` = `automate`). Below it the page opens with a locked panel: "Workflows are paused", "Increase the AI level to unlock Workflows.", and one line naming the current level, how many Workflows are kept, and that they start again when the level is raised. Nothing is deleted.
- The panel's one action is "Raise to Mail that sorts and acts for me". It asks once, inline, saying what starts (routing, background Briefs, Workflows) and that anything leaving the mailbox still asks first; "Turn on" writes `ai.level` through the Shell like the level cards in Settings, and the page unlocks at once. "Not now" forgets the question. "See the AI levels" opens Settings › AI and agent.
- When `ai.level` is set in the Config file the panel says so ("change it there") instead of offering to raise it (ADR 0001).
- Beside the action: what Workflows bring (`strings.workflows.locked.benefits`) and a faded example flow (`strings.workflows.locked.example`).
- Under the panel, "Kept while paused": every Workflow stays listed and selectable, marked Locked, its flow drawn faded. There is no enable switch, Dry run, Run now, rename, ask box or New workflow while locked; Source and the Run log stay readable.

## The list

- One row per Workflow, switched-on first, then by name: the trigger's glyph, the name, the trigger in plain words ("Mail arrives in Hiring › Candidates", "On a schedule: Fridays 16:00"), a status pill, the last run ("Last run 9 min ago" or "Not run yet"), runs today, and the last Runs as outcome dots, oldest first.
- Status, in this order: Locked (the AI level), Paused (switched off), "n waiting" (a Run waits for an approval), Failing (the newest finished Run failed), On.
- The selection stays on a Workflow when a change reorders the list. The last row starts a new Workflow through the agent.
- No Workflows: "Describe the next one" with the example sentences (`strings.workflows.examples`); each hands "Write a new workflow: …" to the composer.

## A Workflow

- The head: the name with Rename (a new version with the new name), the status, where it runs (Placement), the version, the last run; then the enable switch, Dry run, Run now for a manual trigger, and Source (the JSON document, read-only).
- "What you asked for": the sentence the Workflow was written from. Under it, "Ask monday to change this workflow" hands "Change the workflow "name": …" to the composer. There is no editor.
- "How it runs": the Workflow as a vertical flow of cards on a thin rail. The rail and connectors are secondary; each node is a card with content:
  - The trigger card: "When", the trigger in plain words, and its conditions as chips (sender, subject, list, header, attachment, the judged statement with its threshold, the cron in UTC).
  - A Step card: "Step n · kind" ("Post to Slack"), the Step's name, one plain sentence ("Posts to #hiring on Slack"), its fields (message, file name, Notion properties, webhook body, an agent Step's instructions, the tools it may use, what it reports, its Budget) with template holes named ("name from Extract", "the subject"), and the approval it runs under: Asks first (anything that leaves the mailbox, or an agent Step whose tools can), Applies with Undo, Changes nothing, or Runs on your standing approval. A Step's own failure policy shows as one line. `workflows.page.step_details` hides the fields.
  - A condition card: dashed, "Goes on only if …" in words, and both ways: "If yes" and "If not, the run ends here" or "If not, skips <Step>". The Steps it guards sit indented under its "if yes" rail.
- Standing approvals are listed under the flow with Revoke.
- Recent runs (`workflows.page.runs_shown`): each with its outcome glyph, subject, last line and time, and the version when it ran under an older one. Picking one lays that Run over the flow: each card shows Done, Failed, Waiting for you, Skipped or Running with its line, Steps it never reached read "Not reached", and a bar says which Run is shown with "Show the workflow" to go back.
- A Run waiting for an approval shows its approval card above the flow: the Step's exact payload, Approve, "Always allow this step" (a Standing approval) and Decline.
- Dry run shows what the Workflow would have done over recent matching Threads, Thread by Thread, with the judge's answers; nothing is applied.
- The page refreshes every `workflows.page.refresh_seconds`.

## Run history

- A second tab beside the Workflow list, never a Settings section: every Workflow's Runs, newest first (`workflows.page.history_shown`), also reachable from the palette ("Workflow run history").
- Each row: the state glyph, the Workflow's name, a state pill (Running, Waiting, Done, Failed), the subject of the Thread it was about, what started it in plain words, when, and how long it took ("Still running" until it finishes). A failed Run adds the Step it stopped at and its error.
- Picking a Run opens it beside the list: its head (subject, state, Workflow, trigger, when, length, the version when older), Open thread, Open workflow, Close, the failure box for a failed Run, and its Steps laid over the flow of the version it ran under, as on the Workflow's own page.
- Escape closes the open Run, and with none open goes back to the Workflow list. A loading line and an empty state ("No runs yet") are `strings.workflows.run_history.*` Settings.

## The agent's Workflow card

- `create_workflow`, `update_workflow`, `enable_workflow` and `adopt_workflow` preview as a Workflow card (`ToolPreview` kind `workflow`), never a line of text: a lead line (new and switched off; changes to version n; turns on or off), the compact flow with the same cards (trigger, conditions, each Step's glyph, summary and approval), and Group ids named.
- An update says what changes ("1 new, 2 changed, 1 removed", a rename, a new trigger), marks each card New or Changed, and lists removed Steps struck through after the flow.
- An enable carries its Dry run under the flow while `workflows.ask_before_enable` asks.
- Apply, Approve, Decline and Undo are the card's own buttons from the approval path (ADR 0002); Undo of a create deletes the Workflow, of an update points back at the previous version.

## Strings

Every user-visible string is a Setting keyed by name: `strings.workflows.*`, `strings.workflows.flow.*`, `strings.agent.preview_workflow.*`, and the shared `strings.ai.lock.*`.
