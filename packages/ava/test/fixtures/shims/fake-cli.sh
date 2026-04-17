#!/usr/bin/env bash
# Generic fake CLI shim used by backend tests.
# Behavior is controlled via env vars set in the test:
#   FAKE_EXIT      - exit code (default 0)
#   FAKE_STDOUT    - text written to stdout
#   FAKE_STDERR    - text written to stderr
#   FAKE_WRITE     - path (optional) to write 'fake-session-id' into, for simulating session-id emission
set -euo pipefail
if [ -n "${FAKE_STDOUT:-}" ]; then printf "%s" "$FAKE_STDOUT"; fi
if [ -n "${FAKE_STDERR:-}" ]; then printf "%s" "$FAKE_STDERR" 1>&2; fi
if [ -n "${FAKE_WRITE:-}" ]; then printf "fake-session-id" > "$FAKE_WRITE"; fi
exit "${FAKE_EXIT:-0}"
