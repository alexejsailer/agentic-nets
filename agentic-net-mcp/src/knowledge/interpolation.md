# Templates: ${...} and the function set

Template interpolation turns `${path}` placeholders into values from the bound tokens. It runs in
map templates, http url/headers/body, and llm prompts. It does NOT run in command action fields or
pass actions (dynamic commands are built by an upstream map — docs/commands).

## THE rule: the root of every path is the PRESET KEY

If the inscription has `presets: {"input": {...}}`, templates read `${input.data.field}`. If the
preset key were `"request"`, it would be `${request.data.field}`. A mismatched prefix does not
error — it silently resolves to an EMPTY string. Keep preset keys short and boring: `input`,
`request`, `config`.

## Path anatomy

- `${input.data.city}` — a field of the bound token's data.
- `${input._meta.id}` / `${input._meta.name}` — token metadata (`data` and `_meta` never collide).
- `${input.data.results.0.lat}` or `${input.data.results[0].lat}` — array index.
- `${credentials.KEY}` — a secret injected at fire time (docs/security).
- A missing path interpolates to an empty string — silently. When a downstream value comes out
  blank, check the prefix-vs-preset-key rule first.

## Type preservation

A template value that is EXACTLY one placeholder keeps its type: `"count": "${input.data.n}"`
emits a number, `"items": "${input.data.list}"` emits the array. Mixed text
(`"label": "n=${input.data.n}"`) becomes a string.

## Functions (master ≥ 2.27)

Small, safe helpers callable inside `${...}`:

- `${urlencode(input.data.q)}` — URL-encode a value. **Use it for EVERY query/path parameter built
  from data**: a raw `#`, space, or `&` silently corrupts the URL otherwise.
- `${sum(input.data.history)}` — sum a numeric array; `${sum(input.data.history, "uses")}` plucks a
  field from each object first (e.g. summing daily-bucket counts).
- `${len(input.data.items)}` — array/object/string length.
- `${default(input.data.tag, "none")}` — first non-empty argument (coalesce); string literals in
  single or double quotes.
- `${lower(...)}`, `${upper(...)}`, `${trim(...)}` — string cleanup.

Functions compose with the type rule: a lone `${sum(...)}` emits a number. Unknown function names
fall back to plain path resolution (they don't error). On masters older than 2.27 these are
unavailable — the workaround era of "an llm call to add 7 numbers" is over on current stacks.

## Where interpolation does NOT work

- `command` action fields (type/inputPlace/dispatch/await/timeoutMs only — the token carries the
  command).
- `pass` actions (they forward `@input.data` untouched).
- Emit `from` expressions are their own little language (`@response`, `@result`, …) — docs/emit.
