#!/usr/bin/env bash
# deploy-mod.sh — sync mods to the Windows Civ 7 mods directory via WSL
#
# Usage:
#   bash deploy-mod.sh             # recorder only (safe for human SP/MP games)
#   bash deploy-mod.sh --harness   # recorder + AI harness (autoplay dev tool)

set -euo pipefail

MODS_ROOT="/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/Mods"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

DEPLOY_HARNESS=0
for arg in "$@"; do
    case "$arg" in
        --harness) DEPLOY_HARNESS=1 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

deploy_mod() {
    local name="$1"
    local src="${PROJECT_ROOT}/mods/${name}/"
    local dest="${MODS_ROOT}/${name}/"
    mkdir -p "$dest"
    echo "Syncing ${name} -> ${dest}"
    rsync -av --delete "$src" "$dest"
}

deploy_mod "civretro"

if [[ "$DEPLOY_HARNESS" -eq 1 ]]; then
    deploy_mod "civretro-harness"
else
    echo "Skipping civretro-harness (pass --harness to deploy)"
fi

echo "Done."
