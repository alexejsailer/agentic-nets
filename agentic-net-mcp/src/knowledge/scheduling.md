# Scheduling: nets that run while everyone sleeps

A `schedule` on any non-link transition makes it tick server-side with nobody connected:

- Interval: `{"schedule": {"type": "interval", "intervalMs": 60000}}` — at most once per minute.
- Cron: `{"schedule": {"type": "cron", "cron": "0 0 3 * * *"}}` — **6 fields**: sec min hour day
  month weekday (03:00 daily here). Five-field cron silently misparses.

`set_schedule` retrofits a schedule onto an existing transition (and handles the restart —
assigning an inscription stops the transition). Without a schedule, a running transition fires
whenever tokens are available (every poll cycle, ~2s).

## The AND-gate — the single most misdiagnosed behavior

A schedule does not REPLACE token binding; it gates it. A scheduled transition fires only when
BOTH the schedule is due AND its presets bind. Consequences:

- A scheduled transition whose preset can never bind looks completely healthy — RUNNING, valid
  schedule — and never fires. (Field observation: 29 RUNNING scheduled transitions, 1 firing —
  the 1 was the only one with empty presets, a pure clock.)
- Pure clock ticks (no input needed): give the preset `consume:false, optional:true` — the curated
  builders do this automatically when you pass a schedule — or bind a persistent config token.
- Shortening an interval takes effect on the next evaluation; a lengthened interval never fires
  early.

## Diagnosis ladder for "my scheduled nets went silent"

1. `scheduler_status` — per lane: `lastFiredAt` ("silent for 17h" is your headline), `nextFireAt`,
   `eligibility` (masters ≥ 2.28 name the failing gate: NOT_RUNNING | WAITING_FOR_SCHEDULE |
   WAITING_FOR_SCHEDULE_AND_TOKENS | NO_TOKENS | READY), and `overdue`.
2. `overdue: true` (nextFireAt in the past while RUNNING) = the scheduler has NOT re-armed the
   lane — the classic post-redeploy freeze. Recovery: stop → fire_once → start any transition in
   the model; the resulting writes make the scheduler re-read every schedule.
3. Eligibility NO_TOKENS / WAITING_FOR_SCHEDULE_AND_TOKENS → `query_tokens` each preset place; the
   token may be missing, shaped wrong for the ArcQL, or reserved.
4. Still opaque → `dry_run_transition` (what WOULD bind/emit) and `event_trail {q: transitionId}`.

## The autonomy contract

Anything you schedule acts (and possibly spends LLM) unattended. ALWAYS tell the user what you
armed, in plain words ("this will call the API every 10 minutes and summarize nightly at 03:00").
Audit anytime: `net_stats.scheduled` lists every armed lane; `pause_model` freezes them all.
