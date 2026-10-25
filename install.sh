#!/usr/bin/env bash
# install.sh — install or update dsh-plugin-design (Linux / macOS)
#
# The official plugin manager owns installation. This script never removes the
# installed package first: installing over an existing version is the update
# path, and a failed install must not leave the profile without a working
# plugin. Link mode is development-only and must be requested explicitly.
#
# Usage:
#   bash install.sh                       # install/update into the web profile
#   bash install.sh --profile desktop
#   bash install.sh --link                # dev-only junction to this directory
#   bash install.sh --dry-run
#
# Environment overrides: DSHPD_CLI (explicit CLI), DSH_CLI (legacy name).

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="dsh-plugin-design"
PROFILE="web"
LINK=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --link) LINK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ -n "${DSHPD_CLI:-}" ]; then
  DSH="${DSHPD_CLI}"
elif [ -n "${DSH_CLI:-}" ]; then
  DSH="${DSH_CLI}"
elif command -v dsh >/dev/null 2>&1; then
  DSH="$(command -v dsh)"
else
  echo "dsh CLI not found. Install the DSH CLI, or set DSHPD_CLI. This script will not edit a profile directly." >&2
  exit 127
fi

if [ "$LINK" -eq 1 ]; then
  SPEC="link:${PLUGIN_DIR}"
  echo "warning: link mode installs a symlink to this source directory; it is not a distributable installation." >&2
else
  SPEC="${PLUGIN_DIR}"
fi

run_dsh() {
  # Keep stdout/stderr on the terminal; return only the exit status.
  "$DSH" "$@"
  return $?
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: \"${DSH}\" plugin --profile ${PROFILE} add ${SPEC}"
  exit 0
fi

echo "Installing ${PLUGIN_NAME} into profile \"${PROFILE}\" (no remove-then-add)."
status=0
run_dsh plugin --profile "$PROFILE" add "$SPEC" || status=$?
if [ "$status" -ne 0 ]; then
  echo "Installation failed with exit code ${status}. The previous installation was not removed." >&2
  exit "$status"
fi

verify_status=0
run_dsh plugin --profile "$PROFILE" why "$PLUGIN_NAME" || verify_status=$?
if [ "$verify_status" -ne 0 ]; then
  echo "warning: install succeeded but \`dsh plugin why ${PLUGIN_NAME}\` failed." >&2
fi

echo "Installed. Restart the DSH ${PROFILE} client so the Host/Client halves are composed."
