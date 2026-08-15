# Token leases — who is working on what, and why "visible" does not mean "available"

Places are shared and transitions poll them. A **lease** (reservation) is how a fire says "this
token is mine while I work" — without it, the same token would be picked up twice by the same
poller two seconds apart, or by two lanes reading the same place.

## The mechanism, in five facts

1. **A lease is a property ON the token** — `_lock`, holding
   `{"owner": "<transitionId>", "expiresAt": <epochMs>}`. It is an ordinary event-sourced
   mutation: it survives restarts and shows in history.
2. **Taken by compare-and-swap.** The lock write succeeds only if `_lock` still holds the value
   the claimant last read; the master then re-reads to confirm ownership. Two claimants racing:
   one wins, one moves on. No queue, no blocking.
3. **Every lease expires.** Default TTL 60s (per-preset `reservationTtlMs` overrides it). A
   crashed fire cannot freeze a token forever — the system self-heals when the TTL runs out.
   External fires get long leases (the prepared-fire expiry) because a client may reason for
   many minutes.
4. **Binding hides foreign-leased tokens.** When a transition binds its presets, tokens leased
   by anyone else are simply invisible to it — not an error, they just do not appear. This is
   why a lane "randomly" sees an empty place that plainly holds tokens.
5. **A read takes no lease** (since 2.47.0; the not-blocked-by-foreign-locks half since 2.48). A `consume:false` preset only observes: it never
   consumes, so nothing needs mutual exclusion and it neither takes a lock nor is blocked by
   one. Before this, config-place readers starved each other — an agent's session-length lease
   made a sibling's optional config preset bind nothing, and `${config.data.*}` interpolated
   null (the staging `cd "null"` incident). ⚠️ 2.47.0: a CONSUMING lane's lock still hides
   tokens from readers (transparent reads need ≥ 2.48).
6. **Never author `_lock` yourself** — engine state; a forged one in token data hides the
   token from every consuming lane (≥ 2.48 strips it from client writes).

## What this means when YOU act on tokens (MCP client or in-net agent)

- **`query_tokens` shows leased tokens.** Visibility is honest history, not availability. A
  token sitting in `p-*-cmd-ready` for minutes may be *in flight* — the executor took it and is
  running a 5-minute command; the token stays visible until consumption. Results annotate this:
  look for `leased: {owner, expiresInMs}` (derived from `_lock`) before concluding "queued" or
  "stuck".
- **Never delete a token you have not verified unleased.** Deleting a leased token does not
  stop the fire that holds it — the work completes and then its consumption fails. If a place
  looks wedged, `diagnose_transition` first; `delete_tokens` refuses leased tokens unless you
  pass `force:true`.
- **External fires ARE leases.** `prepare_external_fire` leases the shown tokens to you with a
  long expiry; `complete_external_fire` consumes them; `abandon_external_fire` (or expiry)
  releases them unharmed. While you hold the lease, the lane's other tokens remain available to
  other workers — but *those* tokens are invisible to any binding, including a `fire_once` you
  trigger yourself.
- **`stop_transition` releases the lane's leases** (`tokenLocksReleased` in its response) — that
  is the clean way to free tokens a broken lane is holding, not deletion.
- **An empty-looking place is not proof of emptiness.** If a sibling lane leased everything, a
  binding (and your `fire_once`) sees nothing. Check `count_tokens` (counts everything) against
  what a bind reports, and look for `leased` markers in `query_tokens`.
- **Your own retry is safe.** A lane may re-claim its *own* unexpired lease (a failed fire does
  not lock itself out), so re-firing after a transient error is fine.

## Rules of thumb

- Config/reference places: bind them `consume:false` — reads are now lock-free and can never
  collide. Make them `optional:false` when the template interpolates their fields: a lane that
  cannot run without config must wait for it, not fire with nulls.
- Diagnosing "why isn't this firing": leased inputs → someone is working (or a lease has not
  expired yet); no lease + tokens present + RUNNING → look at capacity
  (`diagnose_transition.capacityBlocked`) or the schedule.
- Treat `expiresAt` in the past as "free" — the next claimant CASes over it.
