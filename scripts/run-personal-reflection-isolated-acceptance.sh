#!/usr/bin/env bash
set -Eeuo pipefail
set +x

repo_root="$(git -c safe.directory="$(pwd)" rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git -c safe.directory="$repo_root" status --porcelain)" ]]; then
  printf '%s\n' 'Refusing isolated acceptance from a dirty checkout; commit the exact source tree first.' >&2
  exit 2
fi
command -v docker >/dev/null || { printf '%s\n' 'Docker is required on the operator host.' >&2; exit 2; }
docker compose version >/dev/null

build_sha="$(git -c safe.directory="$repo_root" rev-parse HEAD)"
suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
project="pr-acceptance-${suffix}"
volume_name="${project}_acceptance-data"
port="$((39000 + 16#${suffix} % 1000))"
synthetic_token='isolated-personal-reflection-acceptance-token-v1'
principal_digest="$(printf '%s' "$synthetic_token" | sha256sum | cut -d ' ' -f 1)"

[[ "$project" =~ ^pr-acceptance-[a-f0-9]{12}$ ]] || { printf '%s\n' 'Invalid isolated Compose project name.' >&2; exit 2; }
[[ "$volume_name" =~ ^pr-acceptance-[a-f0-9]{12}_acceptance-data$ ]] || { printf '%s\n' 'Invalid isolated volume name.' >&2; exit 2; }
[[ "$volume_name" != 'hippo-data' ]] || { printf '%s\n' 'Refusing production volume name.' >&2; exit 2; }
if docker volume inspect "$volume_name" >/dev/null 2>&1; then
  printf '%s\n' 'Refusing to reuse an existing Docker volume.' >&2
  exit 2
fi

export HIPPO_ACCEPTANCE_BUILD_SHA="$build_sha"
export HIPPO_ACCEPTANCE_VOLUME_NAME="$volume_name"
export HIPPO_ACCEPTANCE_LOOPBACK_PORT="$port"
export HIPPO_ACCEPTANCE_SYNTHETIC_TOKEN="$synthetic_token"
export HIPPO_ACCEPTANCE_SYNTHETIC_PRINCIPAL="legacy:${principal_digest}"
compose=(docker compose --project-name "$project" --file docker-compose.personal-reflection-acceptance.yml)
output_file="$(mktemp)"

cleanup() {
  result=$?
  trap - EXIT
  rm -f "$output_file"
  if ! "${compose[@]}" down --volumes --remove-orphans >/dev/null; then
    printf '%s\n' 'ISOLATED_VOLUME_CLEANUP=FAIL (docker compose down failed)' >&2
    exit 1
  fi
  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    printf '%s\n' 'ISOLATED_VOLUME_CLEANUP=FAIL (volume remains)' >&2
    exit 1
  fi
  printf '%s\n' 'ISOLATED_VOLUME_CLEANUP=PASS'
  exit "$result"
}
trap cleanup EXIT

run_status=0
"${compose[@]}" up --build --abort-on-container-exit --exit-code-from acceptance-runner >"$output_file" 2>&1 || run_status=$?
runtime_logs="$("${compose[@]}" logs --no-color 2>&1 || true)"
leak_patterns=(
  "$synthetic_token"
  'synthetic acceptance marker'
  'synthetic private statement'
  'provenance marker'
  'rationale marker'
  'restricted marker'
  'practical-representation marker'
  'unavailable marker'
  'synthetic rebuild acceptance marker'
)
for pattern in "${leak_patterns[@]}"; do
  if grep -Fq -- "$pattern" "$output_file" || grep -Fq -- "$pattern" <<<"$runtime_logs"; then
    printf '%s\n' 'Refusing to print acceptance output because a credential or synthetic content marker appeared in logs.' >&2
    exit 1
  fi
done
cat "$output_file"
exit "$run_status"
