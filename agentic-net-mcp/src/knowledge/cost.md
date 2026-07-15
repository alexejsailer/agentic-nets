# Watching the meter: token cost, analyzed and dialed down

An always-on agent team is a living thing, and living things eat. The useful question is never
"is it spending tokens" but "WHICH lanes, and can I turn the expensive ones down without killing
the useful ones". Intuition is a bad guide — the frequent little lanes you notice are usually the
cheapest; one overeager thinker can quietly dominate the entire spend. Use the meter.

## The analyze-and-adapt loop

1. **Measure**: `usage_report` — ranks every transition that fired by MEASURED tokens over a
   window (per-fire average, iterations, duration), plus `burnSplit`: how much burn is scheduled
   coordinators firing on idle vs real work.
2. **Rank**: cost ≈ tokens-per-fire × fires-per-day. The spend concentrates in agent-kind lanes
   (multi-step reasoning, dozens of iterations per fire, potentially millions of tokens each).
   Frequent command/map lanes (poll every minute, report every two) are near zero — leave them.
3. **Retune**: a lane's cadence is ordinary event-sourced config — `set_schedule` (or an
   `inscription.schedule.intervalMs` edit) takes effect on the scheduler's next cycle. No restart,
   no redeploy, no downtime for untouched lanes. A deep thinker that re-analyzes something
   slow-moving every 3 hours probably deserves every 3 days — that single edit is a ~90% cut on
   the biggest line item.
4. **Watch**: `scheduler_status` — the lane's `nextFireAt` reflects the new interval immediately.
   Re-run the loop whenever the spend feels wrong.

## The retune subtlety

Lengthening an interval NEVER triggers a fire (the scheduler compares time-since-last-fire against
the new, longer interval and waits). Shortening one CAN fire immediately — fine for a cheap lane,
something to do deliberately for an expensive one.

## The invisible category

Command lanes whose scripts spawn their OWN model calls (a script that shells out to an LLM CLI
every tick) are invisible to the per-transition token counter — the meter shows a cheap command
fire while the real spend happens inside the subprocess. When the ranking looks suspiciously
clean, read the script bodies of the frequent command lanes. The meter tells you where to look;
the code tells you the rest.

## Related switches

- `net_stats.llm.byTransition` — quick per-lane call counts from the event line (coarser than
  usage_report's token meter, fine for a first glance).
- `pause_model` — the kill switch when you need spend at zero NOW; `resume_model` restores.
- `usage_report {transitionId}` — drill into one lane: aggregate + its recent fires.
- Tell the user what you retuned — cadence changes alter what the system does unattended
  (docs/scheduling: the autonomy contract).
