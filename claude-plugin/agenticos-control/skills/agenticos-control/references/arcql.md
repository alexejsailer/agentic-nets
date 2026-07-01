# ArcQL

ArcQL selects tokens from a place. Used in transition presets (binding) and in ad-hoc queries
(`anos.sh arcql <modelId> '<ARCQL>'`, or `POST /api/proxy/arcql/{modelId}/query {"query":"..."}`).

## Grammar

```
FROM $ [WHERE <condition>] [ORDER BY $.field ASC|DESC] [LIMIT n]
```

- Paths start with `$`: `$.status`, `$.data.nested`, `$.amount`.
- Equality is **double** `==` (not `=`). Strings are **double-quoted**: `$.status=="active"`.
- Comparisons: `>`, `<`, `>=`, `<=`, `!=`. Combine with `AND` / `OR`.

## Examples

```
FROM $                                        -- all tokens
FROM $ WHERE $.status=="active"               -- filter
FROM $ WHERE $.amount > 100                   -- numeric
FROM $ WHERE $.priority=="high" LIMIT 1       -- filter + limit
FROM $ ORDER BY $.ts DESC LIMIT 5             -- newest 5
FROM $ WHERE $.slug!="" AND $.status=="proposed"
```

## Gotchas that bite

- `status='pending'` -> WRONG (single `=`, single quotes). Use `$.status=="pending"`.
- A **bare `$.field`** with no operator is a parse error. To test presence, use `$.field!=""`.
- `take` semantics live in the transition preset (`FIRST` / `ALL` / `LIMIT n`), not in the query string.
- Reserved/locked tokens are hidden by default; pass `?includeReservedFor={transitionId}` on the node ArcQL
  endpoint to see tokens a transition has reserved.
