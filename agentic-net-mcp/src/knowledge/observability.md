# Observability: what each layer can prove

Three layers answer "what did this net do", each with different durability. Know which one you
are reading, or you will mistake eviction for "it never happened".

| Layer | Content | Durability | Tool |
|---|---|---|---|
| Master ring | live events (~2000/model, in-memory) | gone on restart/eviction | `event_trail source:"ring"`, `events_wait` |
| Master journal | same events, JSONL per model/day on disk | `retention-days` (default 7) | `event_trail source:"auto"` (default) / `"journal"` |
| Node event blocks | every committed tree mutation + causal ids | per-model `historyRetentionDays` (default 3) past snapshots | `model_history`, `token_lineage` |

## The 3-day question

`transition_history {transitionId}` = journal stories (fires, outcomes, errors) JOINED with node
mutations via `fireId`. `{focus:"failures"}` returns the latest correlated failure story + raw
error events + (rw) the master's binding diagnosis. Joins are exact-attribute, never substring.

## Retention is configurable

- Node structural history: `PUT /api/admin/catalog/{modelId}/history-retention`
  `{"historyRetentionDays": N}` — persisted on the model descriptor, effective on next load.
  `0` = pre-retention behavior (snapshots wipe covered blocks, ≈1h of history).
- Master story journal: `master.events.journal.{retention-days,max-mb-per-model}`; files live
  under `${LOG_PATH}/event-journal/<modelId>/` (compose log volume / desktop logs dir).

## Honesty rules

- Absence in ANY layer is not proof a fire never happened — check `scheduler_status.fireCount`
  (in-memory but attempt-true) and per-origin `scheduledFireCount` vs `manualFireCount`.
- `historySource: "volatile-runtime-window"` + `degraded: true` = the durable store was
  unavailable; do not treat that page as complete history.
- A matched EventBlock may carry co-committed events from OTHER requests (grouped commits), and
  causal ids are client-asserted — attribution hints, not proofs.
- Cursors carry an `epoch`; `resetDetected` means the master restarted — resume from the
  returned `nextAfterSeq`, and use `source:"auto"` to read past the reset.

## Live tailing

`events_wait {afterSeq, epoch}` long-polls up to 30s against the ring (live only). Loop it with
the returned `nextAfterSeq`; on `resetDetected` keep the new cursor and continue.
