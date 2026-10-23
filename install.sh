#!/usr/bin/env bash
# install.sh — install / upgrade dsh-plugin-design (Linux / macOS)
#
# Preferred (DSH 0.1.5+): official bundle install
#   dsh plugin --profile web add <this directory>
#
# Fallback (no `dsh` CLI on PATH): symlink the package into the profile's
# node_modules and add one insert row to the profile patch. Never both — two
# mount paths would load the plugin twice.
#
# Usage:
#   bash install.sh
#   bash install.sh --profile web
#   bash install.sh --mode link
#
# Environment overrides: DSH_HOME, DSH_PROFILE, DSH_CLI.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="dsh-plugin-design"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
MODE="auto"

while [ $# -gt 0 ]; do
    case "$1" in
        --profile) PROFILE="${2:-}"; shift 2 ;;
        --mode) MODE="${2:-}"; shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0
            ;;
        *) echo "[$PLUGIN_NAME] unknown argument: $1" >&2; exit 2 ;;
    esac
done

case "$MODE" in
    auto|plugin|link) ;;
    *) echo "[$PLUGIN_NAME] --mode must be auto, plugin or link" >&2; exit 2 ;;
esac

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
if [ ! -d "$PROFILE_DIR" ]; then
    echo "[$PLUGIN_NAME] profile dir not found: $PROFILE_DIR"
    echo "  Run dsh at least once first (dsh web), then re-run this script."
    exit 1
fi

node_available() { command -v node >/dev/null 2>&1; }

has_bundle() {
    local pkg="$PROFILE_DIR/package.json"
    [ -f "$pkg" ] || return 1
    if node_available; then
        node -e '
            const fs = require("node:fs");
            try {
                const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                const bundles = pkg?.dsh?.profile?.bundles;
                process.exit(Array.isArray(bundles) && bundles.includes(process.argv[2]) ? 0 : 1);
            } catch { process.exit(1); }
        ' "$pkg" "$PLUGIN_NAME"
    else
        grep -q "\"$PLUGIN_NAME\"" "$pkg"
    fi
}

find_dsh() {
    if [ -n "${DSH_CLI:-}" ] && [ -x "${DSH_CLI}" ]; then
        printf '%s' "$DSH_CLI"
        return 0
    fi
    command -v dsh 2>/dev/null || true
}

DSH_BIN=""
if [ "$MODE" != "link" ]; then
    DSH_BIN="$(find_dsh)"
fi

if [ "$MODE" != "link" ] && [ -z "$DSH_BIN" ]; then
    if [ "$MODE" = "plugin" ]; then
        echo "[$PLUGIN_NAME] no dsh CLI found (PATH or DSH_CLI). Use --mode link as a fallback." >&2
        exit 1
    fi
    echo "[$PLUGIN_NAME] no dsh CLI found; falling back to link mode."
    MODE="link"
fi

if [ "$MODE" != "link" ]; then
    echo "[$PLUGIN_NAME] installing as an official bundle via: $DSH_BIN"
    PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"
    if [ -f "$PROFILE_PATCH" ] && grep -q "id:[[:space:]]*$PLUGIN_NAME" "$PROFILE_PATCH"; then
        echo "[$PLUGIN_NAME] the profile patch still contains a $PLUGIN_NAME row; bundle install plus that row would mount the plugin twice." >&2
        echo "  Remove the row from $PROFILE_PATCH first, then re-run this script." >&2
        exit 1
    fi
    if has_bundle; then
        echo "[$PLUGIN_NAME] already listed in profile bundles; removing before re-adding (HMR refuses install-over-install)."
        "$DSH_BIN" plugin --profile "$PROFILE" remove "$PLUGIN_NAME" || true
    fi
    if ! "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN_DIR"; then
        echo "[$PLUGIN_NAME] 'dsh plugin add' failed. Check pnpm output above (build scripts, registry, engines.dsh)." >&2
        exit 1
    fi
    if ! has_bundle; then
        echo "[$PLUGIN_NAME] installed, but the profile bundle list does not contain $PLUGIN_NAME." >&2
        echo "  Check $PROFILE_DIR/package.json." >&2
        exit 1
    fi
    echo "[$PLUGIN_NAME] installed as a bundle. Restart dsh (or let HMR reload) and refresh the page."
    echo "  Chat: 12 dshpd_* tools · Settings → dsh plugin design"
    exit 0
fi

# ---- fallback: symlink + profile patch ------------------------------------
echo "[$PLUGIN_NAME] fallback link mode (no official bundle install)."
if has_bundle; then
    echo "[$PLUGIN_NAME] the profile already selects this bundle; do NOT also add a profile patch row (double mount)."
    echo "  Remove it with: dsh plugin --profile $PROFILE remove $PLUGIN_NAME"
    exit 0
fi

for NODE_MODULES in "$DSH_HOME/profiles/node_modules" "$PROFILE_DIR/node_modules"; do
    if [ ! -d "$NODE_MODULES" ]; then
        if [ "$NODE_MODULES" = "$PROFILE_DIR/node_modules" ]; then
            continue
        fi
        mkdir -p "$NODE_MODULES"
    fi
    LINK="$NODE_MODULES/$PLUGIN_NAME"
    if [ -L "$LINK" ]; then
        rm "$LINK"
    elif [ -e "$LINK" ]; then
        echo "[$PLUGIN_NAME] $LINK exists and is not a symlink; remove it manually, then re-run." >&2
        exit 1
    fi
    ln -s "$PLUGIN_DIR" "$LINK"
    echo "[$PLUGIN_NAME] symlink created: $LINK -> $PLUGIN_DIR"
done

PATCH="$PROFILE_DIR/cordis.patch.yml"
touch "$PATCH"
if grep -q "id:[[:space:]]*$PLUGIN_NAME" "$PATCH"; then
    echo "[$PLUGIN_NAME] profile patch already contains this row; skipped."
else
    cat >> "$PATCH" <<EOF

# $PLUGIN_NAME - host composition (global tools + settings UI)
- insert:
    - id: $PLUGIN_NAME
      name: '$PLUGIN_NAME'
EOF
    echo "[$PLUGIN_NAME] wrote: $PATCH"
fi

echo ""
echo "[$PLUGIN_NAME] install complete (link mode)."
echo "  Restart dsh, then refresh the page: 12 dshpd_* tools · Settings → dsh plugin design."
