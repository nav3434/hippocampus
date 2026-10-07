# Personal Reflection production acceptance

This runner sends MCP calls to an explicitly selected deployment and uses only fresh synthetic UUIDs and marker text. It fails closed unless the caller supplies the exact synthetic mode, an HTTPS target (loopback HTTP is permitted for a disposable local server), and a bearer token. It never prints a bearer token or stores the synthetic statement in its report. The runner always attempts exact deletion and read-back for the UUID it created; on cleanup failure its JSON report contains only that UUID and the version needed for recovery.

**Merging this PR does not constitute production acceptance of scoped retrieval.** The harness covers only B, E, and part of F. A, C, D, and the remaining F checks stay BLOCKED until a separate controlled step resolves their documented evidence or safety requirements. `/v1/retrieval/export` remains disabled. The absence of GitHub status checks is not a CI pass.

Run from a reviewed checkout after installing the repository's locked dependencies:

```powershell
$env:HIPPO_ACCEPTANCE_MODE = 'synthetic-only'
$env:HIPPO_ACCEPTANCE_TARGET_URL = 'https://<approved-host>/mcp'
$env:HIPPO_ACCEPTANCE_AUTH_KIND = 'agent' # agent, legacy, or oauth
$secret = Read-Host 'Approved Hippocampus bearer token' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $env:HIPPO_ACCEPTANCE_BEARER_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
npm run acceptance:personal-reflection
Remove-Item Env:HIPPO_ACCEPTANCE_BEARER_TOKEN
```

The JSON output has a PASS/FAIL/BLOCKED/NOT_RUN result for each contract group A-F. A nonzero exit code means at least one group failed, is blocked, or synthetic cleanup failed. Do not treat BLOCKED as acceptance or use `/v1/retrieval/export` as a workaround.

## Docker acceptance image

The acceptance runner is packaged in a separate `personal-reflection-acceptance` stage. The production runtime stage does not include the runner or its scripts. Build and tag the client-only image from the repository root; this requires Docker on the host, not Node.js or npm:

```sh
docker build --target personal-reflection-acceptance -t hippocampus-personal-reflection-acceptance:local .
```

To verify the image and fail-closed preflight without credentials or network access, run it without a bearer token. It should emit its machine-readable blocked report and exit nonzero before connecting or writing:

```sh
docker run --rm \
  -e HIPPO_ACCEPTANCE_MODE=synthetic-only \
  -e HIPPO_ACCEPTANCE_TARGET_URL=https://acceptance.invalid/mcp \
  -e HIPPO_ACCEPTANCE_AUTH_KIND=agent \
  hippocampus-personal-reflection-acceptance:local
```

For an authorized controlled run, pass credentials through the Docker client's environment forwarding rather than placing a bearer value in command history:

```sh
read -r -s -p 'Approved Hippocampus bearer token: ' HIPPO_ACCEPTANCE_BEARER_TOKEN; echo
export HIPPO_ACCEPTANCE_BEARER_TOKEN
export HIPPO_ACCEPTANCE_MODE=synthetic-only
export HIPPO_ACCEPTANCE_TARGET_URL=https://<approved-host>/mcp
export HIPPO_ACCEPTANCE_AUTH_KIND=agent # agent, legacy, or oauth
docker run --rm \
  --env HIPPO_ACCEPTANCE_BEARER_TOKEN \
  --env HIPPO_ACCEPTANCE_MODE \
  --env HIPPO_ACCEPTANCE_TARGET_URL \
  --env HIPPO_ACCEPTANCE_AUTH_KIND \
  hippocampus-personal-reflection-acceptance:local
unset HIPPO_ACCEPTANCE_BEARER_TOKEN HIPPO_ACCEPTANCE_MODE HIPPO_ACCEPTANCE_TARGET_URL HIPPO_ACCEPTANCE_AUTH_KIND
```

The image has no default target or credentials. The target must be explicitly approved, and this command does not deploy or modify the Hippocampus service.

## Authentication identity

The server assigns `oauth:<stored client_id>` to a valid OAuth access token. A valid configured agent bearer receives `agent:<lowercase SHA-256 hex of the exact bearer>`. In legacy single-token mode, `HIPPO_TOKEN` receives `legacy:<lowercase SHA-256 hex of that token>`. The MCP session is bound to the principal that initialized it; subsequent requests with a different authenticated principal are rejected. The runner report contains only `identity_type` and `identity_source`; it does not calculate or emit the full derived principal, raw bearer, or OAuth client ID. To configure an allowlist in a separately reviewed change, use the exact principal from the existing service identity: verify the registered OAuth client ID server-side, or compute `agent:`/`legacy:` plus SHA-256 of the exact configured token in a trusted local process without printing the token. If the OAuth identity cannot be verified, do not allowlist it. Never paste the raw bearer into the allowlist.

The supplied deployment state has `HIPPO_PERSONAL_REFLECTION_PRINCIPALS` empty/unset, so scoped calls should be denied. A positive run requires a separately reviewed deployment change to allowlist the exact existing service identity; this PR and runner do not change compose, secrets, or production configuration. `docker-compose.yml` currently does not pass that variable to the container.

## What this runner can and cannot accept

- **B, lifecycle:** against an authorized deployment, checks deterministic create/retry, same-version digest conflict, revision replacement, stale update/delete rejection, recall version, and exact cleanup/read-back using one synthetic UUID.
- **E, backend recall surface:** checks that the scoped recall response contains only `canonical_id` and `canonical_version` and no synthetic marker. The `get` operation is only used internally as the contract's reconciliation read-back, and its content is never emitted.
- **F, basic fail-closed controls:** checks unauthenticated denial, the authenticated allowlist gate, and negative scope/consumer/sensitivity requests. Transport faults, timeouts, malformed packets, unsupported capabilities, and deliberate degradation cannot be safely induced against the production service by this runner and remain NOT_RUN/BLOCKED until a separately controlled fault-injection environment exists.
- **A, scope isolation:** the shipped code filters by scope in SQL before materializing vector candidates and ranking them, and the contract status advertises that property. A deployed acceptance proof still needs a candidate/query-plan trace or an equivalent backend attestation tied to a build identity. Neither is exposed by the deployed MCP contract, so this runner reports BLOCKED rather than treating a status boolean or client-side observation as proof. It does not create global control memories or probe other scopes.
- **C, rebuild:** not run against production. `personal_reflection_rebuild_activate` changes the active pointer and deletes the entire previous generation for the only supported `personal-reflection` scope. The API has no isolated namespace, scope inventory, or rollback snapshot, so a synthetic rebuild could erase unrelated production records. C requires a separately provisioned empty production-equivalent deployment or an approved non-destructive backend test fixture; this runner will not activate or abort a production generation.
- **D, canonical resolution:** canonical lifecycle/version/sensitivity/epistemic checks and the distinction between base-profile and thematic-recall belong to `personal-system`. The Hippocampus backend only returns candidates, so it cannot honestly verify these decisions. Use the existing canonical store/client acceptance suite in `personal-system`; a production end-to-end result also requires that client component to be deployed and connected.

The deployed status tool does not return a build identifier. Capture the deployment's build identity through its existing operator-controlled release record alongside this report; the runner marks the identity unavailable instead of guessing from this checkout.

## Recovery

If `cleanup.status` is `failed`, use only the `synthetic_ids` entry and exact `personal_reflection_delete` instruction in `cleanup.recovery`. Call `personal_reflection_get` for that same UUID and verify `found=false`. Do not use rebuild, database reset, broad deletion, or the record's content to recover. If a run is interrupted before its JSON report is written, the printed synthetic UUID may be absent; inspect only the MCP audit's content-free request metadata and do not guess at a UUID.
