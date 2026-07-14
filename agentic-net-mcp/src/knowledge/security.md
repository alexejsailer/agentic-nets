# Scope & security

This server enforces a MODEL ALLOWLIST in-process: every tool call is validated against
AGENTICOS_MODELS before anything reaches the backend; out-of-list models return
MODEL_NOT_ALLOWED. Readonly deployments authenticate with the gateway's readonly client — the
GATEWAY itself rejects mutations (403), and mutating tools are not even registered.

Honest boundary: the underlying gateway credential is not model-scoped (the platform has no
per-model authorization yet), so the allowlist protects against client/LLM mistakes and prompt
injection — not against a malicious operator of this process. Never ask for or echo secrets.

## The ONE sanctioned secret path

Transition secrets (API keys, bearer tokens) go through set_transition_credentials — stored
vault-backed (or encrypted at rest), injected at fire time via ${credentials.KEY} inside the
inscription's action (header values, url, body, or auth.credentialKey). The tool never echoes
secret values back; neither should you.

Never put a secret anywhere else:
- NOT hardcoded in an inscription — inscriptions are readable by every rw client.
- NOT in a token (including "config tokens") — tokens are EVENT-SOURCED: a pasted secret is
  permanently recorded in the model's event history even after you delete the token.

## Readonly limitation

ArcQL queries travel as POST, which the gateway's readonly scope rejects — plain-substring
memory_recall and query_tokens WITHOUT an arcql argument work fine in readonly (they use GET
endpoints); pass ArcQL only in rw mode. The POST-based diagnostics (diagnose/dry-run/verify) are
rw-only; the GET-based reads (net_stats, list_transitions, scheduler_status, llm_health,
search_knowledge) all work in readonly.
