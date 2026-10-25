# Curation

The person's agreement with a model, per subject: a net (`session::net`), one element of a net
(`session::net#elementId`), a level (its id) or a relation (`from::net>relation>to::net`).

- `confirm`: the subject describes what it claims to describe, at a revision; an optional
  `sourceHash` records the state of the referenced sources (documents, code, data, any file the
  definition names) at that moment.
- `flag`: `stale`, `unclear`, `wrong`, `contradiction`, `unmeasured`, `too-coarse`,
  `level-below-changed` or `level-above-changed`; open until resolved. The guard `exists:false` on
  `markId` makes a deterministic id idempotent, so a repeated mechanical check never doubles a flag.
- `resolve`: `changed`, `confirmed` or `withdrawn`; the flag's status becomes `resolved`.
- `defer`: put a subject aside `until` a date; the worklist and the Focus view leave it out meanwhile.
- `pass`: a refinement pass record: the answers and marks up to `consumedUntil` were applied top-down, with the changes made and the questions raised for the next focus session. The model's digest (`GET /api/explorer/{model}/digest`) starts after the last pass.

Marks are append-only tokens; readers fold them (newest confirmation wins, any open flag makes the
subject flagged). The Model Explorer shows the fold on every band and card, filters by "needs me"
and writes through these actions; the MCP server reads it with `review_model` and `refine_model`.

This application has no UI of its own: Studio renders its stores generically, and the Explorer is
its surface. It is therefore the first manifest-only application in this workspace: `pack:curation`
packs it without a web component.

```bash
npm run pack:curation            # dist/packages/curation-1.2.0.application.json
npm run test:curation-package    # re-verifies roles, actions and guards
npm run publish:curation         # uploads it to a running gateway's NetHub
```

The AgenticNetOS master seeds the same artifact into every fresh installation (its copy under
`application-templates/` is generated from here; regenerate and copy, never edit the copy).
