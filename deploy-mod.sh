#!/usr/bin/env bash
# deploy-mod.sh — sync mods to the Windows Civ 7 mods directory via WSL

set -euo pipefail

MODS_ROOT="/mnt/c/Users/Bernie Conrad/AppData/Local/Firaxis Games/Sid Meier's Civilization VII/Mods"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

deploy_mod() {
    local name="$1"
    local src="${PROJECT_ROOT}/mod/${name}/"
    local dest="${MODS_ROOT}/${name}/"
    mkdir -p "$dest"
    echo "Syncing ${name} -> ${dest}"
    rsync -av --delete "$src" "$dest"
}

deploy_mod "civretro"
deploy_mod "civretro-harness"

echo "Done."
