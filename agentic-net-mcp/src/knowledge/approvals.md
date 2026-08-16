# Approval Room: independent decisions and safe retries

`requests` is canonical; `decisions` and `evidence` are append-only. Never assume place IDs: list
and describe applications, select the pending-approval `agentProtocol`, resolve `taskStoreRole`,
then derive its workflow action and input.

## Separation of duty

Exclude pending tokens whose `requestedBy` equals your Persona id, then rely on the runtime
guard: approve/reject/requestChanges require `actor != requestedBy`; resubmit requires equality.
The guard, not a UI hint or promise, is authority. After acting, re-read the request and correlated
audit. A concurrent reviewer may have won; never auto-retry a guard/409 with a new decision.

## Ambiguous response

Mint one `idempotencyKey` per logical action and retain it after timeout/disconnect/unknown
response. Reuse it only with identical input. `replayed:true` is success already committed; the
same key with different input conflicts. Never author system fields `actionRequestId` or
`actionRequestHash`.

Idempotency answers whether the append committed. Guard + optimistic version answer whether state
is still eligible. Approval workflows need both.
