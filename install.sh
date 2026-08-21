#!/usr/bin/env bash
# install.sh — install dsh-plugin-design into DeepSeek Harness (Linux/macOS)
#
# Usage (inside the cloned directory):
#   bash install.sh
#
# Idempotent: links the package into node_modules and appends an insert row
# to cordis.patch.yml.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

if [ ! -d "$PROFILE_DIR" ]; then
    echo "[dsh-plugin-design] profile dir not found: $PROFILE_DIR"
    echo "  Run dsh at least once first (dsh web), then re-run this script."
    exit 1
fi

# ---- 1) node_modules symlink -> plugin directory ----
NODE_MODULES="$DSH_HOME/profiles/node_modules"
LINK="$NODE_MODULES/dsh-plugin-design"
mkdir -p "$NODE_MODULES"

if [ -L "$LINK" ]; then
    if [ "$(readlink "$LINK")" = "$PLUGIN_DIR" ]; then
        echo "[dsh-plugin-design] already linked to this directory."
    else
        rm "$LINK"
        ln -s "$PLUGIN_DIR" "$LINK"
        echo "[dsh-plugin-design] symlink updated -> $PLUGIN_DIR"
    fi
elif [ -e "$LINK" ]; then
    echo "[dsh-plugin-design] $LINK exists and is not a symlink; remove it manually, then re-run."
    exit 1
else
    ln -s "$PLUGIN_DIR" "$LINK"
    echo "[dsh-plugin-design] symlink created -> $PLUGIN_DIR"
fi

# ---- 2) append insert row to cordis.patch.yml ----
PATCH="$PROFILE_DIR/cordis.patch.yml"
touch "$PATCH"
if grep -q 'id:[[:space:]]*dsh-plugin-design' "$PATCH"; then
    echo "[dsh-plugin-design] cordis.patch.yml already contains this plugin row; skipped."
else
    cat >> "$PATCH" <<'EOF'

# dsh plugin design - host composition (global tools + settings UI)
- insert:
    - id: dsh-plugin-design
      name: 'dsh-plugin-design'
EOF
    echo "[dsh-plugin-design] wrote: $PATCH"
fi

echo ""
echo "[dsh-plugin-design] Install complete."
echo "  Restart dsh: press Ctrl+C on the running dsh, then run: dsh web"
echo "  After restart: 10 dshpd_* tools in chat; Settings -> dsh plugin design page appears."
