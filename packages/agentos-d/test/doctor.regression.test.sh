#!/usr/bin/env zsh
# doctor.regression.test.sh — regression guard for awos-doctor.sh text mode.
#
# Asserts that `awos-doctor.sh` (no flags) produces output that, after
# normalization, is byte-identical to the canonical fixture captured when
# the sprint was baselined.
#
# Normalization filter (applied to both actual and fixture before diff):
#   1. pid=<digits>  → pid=REDACTED
#   2. "startedAt":"<iso>"  → "startedAt":"REDACTED"
#   3. "now":"<iso>"  → "now":"REDACTED"
#   4. "dispatch_queue counts queued=<n> dispatched=<n>"
#      → "dispatch_queue counts queued=REDACTED dispatched=REDACTED"
#
# These lines vary on every run (process IDs, daemon start time, queue depth)
# but their STRUCTURE is fixed. The test asserts no new lines appear or
# disappear — "no new differences", not "no warnings."
#
# Exit 0 = pass, exit 1 = fail.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DOCTOR="${AWOS_DOCTOR_PATH:-$HOME/.agentworks/scripts/awos-doctor.sh}"
FIXTURE="$REPO_ROOT/packages/agentos-d/test/fixtures/doctor/text-mode-baseline.txt"

if [[ ! -x "$DOCTOR" ]]; then
  echo "FAIL: doctor script not found or not executable: $DOCTOR" >&2
  exit 1
fi

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL: fixture file not found: $FIXTURE" >&2
  exit 1
fi

normalize() {
  sed \
    -e 's/pid=[0-9]\{1,\}/pid=REDACTED/g' \
    -e 's/"startedAt":"[^"]*"/"startedAt":"REDACTED"/g' \
    -e 's/"now":"[^"]*"/"now":"REDACTED"/g' \
    -e 's/dispatch_queue counts queued=[0-9]* dispatched=[0-9]*/dispatch_queue counts queued=REDACTED dispatched=REDACTED/'
}

actual="$(zsh "$DOCTOR" 2>&1 || true)"
actual_norm="$(printf '%s\n' "$actual" | normalize)"
fixture_norm="$(normalize < "$FIXTURE")"

if diff_out="$(diff <(printf '%s\n' "$fixture_norm") <(printf '%s\n' "$actual_norm"))"; then
  echo "PASS: awos-doctor.sh text mode matches fixture (after normalization)"
  exit 0
else
  echo "FAIL: awos-doctor.sh text mode has NEW differences vs fixture" >&2
  echo "$diff_out" >&2
  exit 1
fi
