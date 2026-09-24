# Designtime views of the Steward

The four canonical nets in `../nets/` are what the pack installs and what the inscriptions belong
to. The drawings in this directory are **views**: designtime nets over the same runtime element
ids, one for the whole Steward (`steward-full`) and one per stage, laid out left to right so each
fits a Studio editor without maximizing. They carry no inscriptions and change nothing at runtime;
deleting one deletes a drawing, never a place or a transition.

Regenerate and (re)create them in a running model:

```bash
export AGENTICOS_SERVICE_TOKEN=...   # the runtime's internal service token
python3 make-views.py --model steward --session agent-steward
```

`--write-only` only rewrites the `*.pnml.json` files.
