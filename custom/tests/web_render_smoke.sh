#!/usr/bin/env bash
set -euo pipefail

base_url=${NWPUOJ_WEB_URL:-http://127.0.0.1}
problem_id=${NWPUOJ_SMOKE_PROBLEM_ID:-1}
contest_id=${NWPUOJ_SMOKE_CONTEST_ID:-}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

check_page() {
  local name=$1
  local path=$2
  local expected_status=$3
  local response="$temporary/$name.html"
  local status
  status=$(curl -sS -L -o "$response" -w '%{http_code}' "$base_url$path")
  if [[ "$status" != "$expected_status" ]]; then
    echo "$name returned HTTP $status; expected $expected_status" >&2
    return 1
  fi
  rg -q 'data-app-shell' "$response"
  rg -q '<title>' "$response"
  if rg -q 'ReferenceError:|Template render error|Cannot find module' "$response"; then
    echo "$name rendered an application error" >&2
    return 1
  fi
  echo "$name $status"
}

check_page home / 200
check_page problems /problems 200
check_page problem "/problem/$problem_id" 200
check_page contests /contests 200
check_page ranklist /ranklist 200
check_page help /help 200
check_page login /login 200
check_page sign_up /sign_up 200
check_page submit_requires_login "/problem/$problem_id/submit" 401

if [[ -n "$contest_id" ]]; then
  check_page contest "/contest/$contest_id" 200
  check_page contest_ranklist "/contest/$contest_id/ranklist" 200
fi
