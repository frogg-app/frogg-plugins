#!/usr/bin/env bash
# Builds and packs every plugin under plugins/<category>/<id>/ into out/.
# Usage: scripts/build-all.sh
set -euo pipefail
shopt -s nullglob

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/out"

for manifest in "$root"/plugins/*/*/frogg-plugin.json; do
  dir="$(dirname "$manifest")"
  category="$(basename "$(dirname "$dir")")"
  id="$(basename "$dir")"
  if ! node -e 'const c=require(process.argv[1]).categories.map((x)=>x.id);process.exit(c.includes(process.argv[2])?0:1)' "$root/categories.json" "$category"; then
    echo "error: $dir: category '$category' is not declared in categories.json" >&2
    exit 1
  fi
  manifest_id="$(node -p 'require(process.argv[1]).id' "$manifest")"
  if [[ "$manifest_id" != "$id" ]]; then
    echo "error: $dir: directory name '$id' does not match manifest id '$manifest_id'" >&2
    exit 1
  fi
  echo "==> $category/$id"
  npm run --prefix "$dir" build
  frogg plugins pack "$dir" --out "$root/out"
done
