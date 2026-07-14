# ArcQL

Token query language used in preset bindings and query_tokens.

```
FROM $                                  -- all tokens
FROM $ WHERE $.status=="active"         -- equality: DOUBLE equals, DOUBLE quotes
FROM $ WHERE $.amount > 100             -- numeric comparison
FROM $ WHERE $.a=="x" AND $.b=="y"      -- conjunction
FROM $ ORDER BY $.createdAt DESC LIMIT 5
FROM $ LIMIT 1                          -- the default preset binding
```

Paths always start with `$.`. The top-3 mistakes: single `=` instead of `==`, single quotes
instead of double quotes, missing `$` prefix on the field path.

## In presets

A preset's `arcql` must NEVER be empty — even a link transition's preset carries `FROM $ LIMIT 1`
(an empty one makes the master's status polling spam errors against the node). Preset extras:

- `take`: `FIRST` (one token per fire, the default) or `ALL` (bind every match).
- `consume`: `true` (default — the fire removes the token) or `false` (re-read each fire; the
  pattern for persistent config tokens read by scheduled transitions).
- `optional`: `true` lets the transition fire even when this preset binds nothing (used together
  with schedules, so a tick doesn't require a token).

A token reserved by one transition (mid-fire) is invisible to competing queries until released —
reservation is compare-and-swap, so two transitions never consume the same token.

## Readonly caveat

ArcQL travels as POST, which the gateway's readonly scope rejects. In readonly mode use
query_tokens WITHOUT the arcql argument (plain GET reads) — filtering happens client-side.
