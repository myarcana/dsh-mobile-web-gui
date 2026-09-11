#!/usr/bin/env bash
# Build this plugin and install it into a dsh profile.
#
# Two things about a profile's node_modules/<plugin> make a plain `pnpm install`
# insufficient, and both have cost a debugging session:
#
#   1. `lib/index.js` is a COPY, not a link. tsdown deletes and recreates that
#      file every build, so the profile keeps executing the previous bundle while
#      the source looks correct. The harness gives no sign it is running stale
#      code.
#   2. `client/**` is HARDLINKED, but only for files that existed at install
#      time. A newly added client module does not appear in the profile at all,
#      so the import map omits it and every page load throws on the missing
#      module.
#
# So: build, then mirror the client tree and copy the entry. Run this after
# touching src/ or client/ and before restarting the service.
#
# Usage: scripts/install-into-profile.sh [profile] [plugin-name]
set -euo pipefail

PROFILE="${1:-web}"
PLUGIN="${2:-dsh-mobile-web-gui}"
DSH_HOME="${DSH_HOME:-/root/.dsh}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$DSH_HOME/profiles/$PROFILE/node_modules/$PLUGIN"

[ -d "$DEST" ] || { echo "no such plugin install: $DEST" >&2; exit 1; }

cd "$SRC"
echo "building $PLUGIN..."
npx tsdown 2>&1 | tail -3

# 1. the built entry, which the hardlink trap leaves behind
cp "$SRC/lib/index.js" "$DEST/lib/index.js"
echo "installed lib/index.js ($(wc -c < "$DEST/lib/index.js") bytes)"

# 2. every client module, so a newly added one is not missing from the import map.
# Compared by inode first: an existing module is already hardlinked to the
# source, and `cp` refuses to copy a file onto itself.
for module in "$SRC"/client/*.js "$SRC"/client/*.css; do
  name="$(basename "$module")"
  target="$DEST/client/$name"
  if [ -f "$target" ] && [ "$(stat -c %i "$target")" = "$(stat -c %i "$module")" ]; then
    continue
  fi
  cp -f "$module" "$target"
done
echo "installed client modules: $(ls -1 "$DEST/client" | tr '\n' ' ')"

# 3. prove it, rather than assume: the symbols just built must be in the install
if ! grep -q "LEAVES" "$DEST/lib/index.js"; then
  echo "WARNING: installed bundle looks wrong (no LEAVES)" >&2
fi
missing=0
for module in "$SRC"/client/*.js; do
  name="$(basename "$module")"
  [ -f "$DEST/client/$name" ] || { echo "MISSING in profile: $name" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1
echo "ok — restart to load: systemctl restart dsh-$PROFILE"
