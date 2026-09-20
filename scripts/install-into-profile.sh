#!/usr/bin/env bash
# Build this plugin and land it in a dsh profile.
#
# The profile installs this plugin with `link:`, so the profile's
# node_modules/<plugin> is a SYMLINK to this checkout — the checkout is what
# actually runs. That removes both frictions the older `file:` copy had:
#
#   1. no copy step, so no write into $DSH_HOME. A dsh session is sandboxed to
#      its workspace, and $DSH_HOME is outside it, so the copy used to stall on
#      a one-shot `danger-full-access` approval prompt. There is nothing to
#      approve now.
#   2. no stale-copy trap. tsdown deletes and recreates lib/index.js, which
#      silently desynchronized the old copied entry; there is only one file now.
#
# What a change costs after this script:
#
#   client/**   live on the next page load — the plugin re-reads its asset table
#               on every document request and serves digest-stamped URLs, so a
#               rebuilt client file is picked up with NO restart.
#   src/**      the host half, bundled into lib/index.js. It is imported at
#               boot, so it needs `systemctl restart dsh-<profile>`. A restart
#               interrupts EVERY turn in flight, web sessions included — count
#               `running: true` rows first and schedule it, never fire it
#               mid-task.
#
# Usage: scripts/install-into-profile.sh [profile] [plugin-name]
set -euo pipefail

PROFILE="${1:-web}"
PLUGIN="${2:-dsh-mobile-web-gui}"
DSH_HOME="${DSH_HOME:-/root/.dsh}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$DSH_HOME/profiles/$PROFILE/node_modules/$PLUGIN"

# The install must be the link: model, or a build here lands nowhere and the
# profile keeps serving a copy this script cannot see.
if [ ! -e "$DEST" ]; then
  echo "no such plugin install: $DEST" >&2
  exit 1
fi
if [ ! -L "$DEST" ]; then
  echo "WARNING: $DEST is a real directory, not a symlink." >&2
  echo "         This profile is on the old file: copy model, so this script cannot" >&2
  echo "         deploy to it. Convert it first:" >&2
  echo "           rm -rf \"$DEST\"" >&2
  echo "           ln -s \"$SRC\" \"$DEST\"" >&2
  echo "         and set the dependency to link:$SRC in the profile package.json." >&2
  exit 1
fi
RESOLVED="$(readlink -f "$DEST")"
if [ "$RESOLVED" != "$SRC" ]; then
  echo "WARNING: $DEST points at $RESOLVED, not this checkout ($SRC)." >&2
  echo "         Building here would not change what the profile runs." >&2
  exit 1
fi

cd "$SRC"
echo "building $PLUGIN..."
BIN="$SRC/node_modules/.bin/tsdown"
if [ -x "$BIN" ]; then "$BIN" 2>&1 | tail -3; else npx tsdown 2>&1 | tail -3; fi

# Prove the build, rather than assume: the entry the harness loads is this one
# file, and a failed build can leave the previous bundle in place. The marker is
# the derived import map, which is what this bundle must contain — the older
# hand-maintained list it used to be checked against no longer exists.
if ! grep -q "importmap" "$SRC/lib/index.js"; then
  echo "WARNING: built bundle looks wrong (no import map)" >&2
  exit 1
fi
echo "built lib/index.js ($(wc -c < "$SRC/lib/index.js") bytes)"

# Every client module must exist, because the served import map names them by
# digest and the entry imports them directly; a missing one throws on load.
missing=0
for module in "$SRC"/client/*.js; do
  [ -f "$module" ] || { echo "MISSING client module: $module" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1
echo "client modules: $(ls -1 "$SRC/client" | tr '\n' ' ')"

echo "ok — client changes are live on the next page load."
echo "     host changes (src/**) need: systemctl restart dsh-$PROFILE"
