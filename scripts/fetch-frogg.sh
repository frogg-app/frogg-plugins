#!/usr/bin/env bash
# Installs the frogg CLI and the plugin API types into .frogg/ for CI and local builds.
#
#   FROGG_VERSION=1.7.0 scripts/fetch-frogg.sh   release daemon bundle (sha256-checked) + types from tag v1.7.0
#   FROGG_REF=main scripts/fetch-frogg.sh        builds the CLI from source at that branch, tag or commit
#
# FROGG_VERSION wins when both are set. FROGG_REPO overrides the source repository
# (default frogg-app/frogg). Writes .frogg/bin/frogg and .frogg/plugin-api/index.d.ts; when
# GITHUB_PATH is set, .frogg/bin is added to PATH for later steps.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
repo="${FROGG_REPO:-frogg-app/frogg}"
dest="$root/.frogg"
rm -rf "$dest"
mkdir -p "$dest/bin" "$dest/plugin-api"

function install_release() {
  local version="$1"
  local arch
  case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  local asset="frogg-${version}-linux-${arch}-daemon.tar.gz"
  local base="https://github.com/${repo}/releases/download/v${version}"
  echo "==> frogg ${version} release bundle"
  curl -fsSL -o "$dest/$asset" "$base/$asset"
  curl -fsSL -o "$dest/$asset.sha256" "$base/$asset.sha256"
  local expected actual
  expected="$(awk '{print $1}' "$dest/$asset.sha256")"
  actual="$(sha256sum "$dest/$asset" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "error: $asset sha256 mismatch (expected $expected, got $actual)" >&2
    exit 1
  fi
  mkdir -p "$dest/daemon"
  tar -xzf "$dest/$asset" -C "$dest/daemon" --strip-components=1
  rm -f "$dest/$asset" "$dest/$asset.sha256"
  ln -s "$dest/daemon/bin/frogg" "$dest/bin/frogg"
  curl -fsSL -o "$dest/plugin-api/index.d.ts" \
    "https://raw.githubusercontent.com/${repo}/v${version}/packages/plugin-api/index.d.ts" || {
    echo "error: v${version} has no packages/plugin-api; use a release with plugin support or FROGG_REF" >&2
    exit 1
  }
}

function install_source() {
  local ref="$1"
  local src="$dest/src"
  echo "==> frogg CLI from source at ${ref}"
  git init -q "$src"
  git -C "$src" remote add origin "https://github.com/${repo}.git"
  git -C "$src" fetch -q --depth 1 origin "$ref"
  git -C "$src" checkout -q FETCH_HEAD
  (
    cd "$src"
    npm ci --ignore-scripts --no-audit --no-fund --include-workspace-root \
      -w @frogg/branding -w @frogg/protocol -w @frogg/client -w @frogg/highlight \
      -w @frogg/relay -w @frogg/server -w @frogg/cli
    npm run brand:prepare
    for workspace in protocol client highlight relay server cli; do
      npm run build --workspace="@frogg/${workspace}"
    done
  )
  cat >"$dest/bin/frogg" <<LAUNCHER
#!/usr/bin/env bash
exec node "$src/apps/cli/bin/frogg" "\$@"
LAUNCHER
  chmod +x "$dest/bin/frogg"
  cp "$src/packages/plugin-api/index.d.ts" "$dest/plugin-api/index.d.ts"
}

if [[ -n "${FROGG_VERSION:-}" ]]; then
  install_release "${FROGG_VERSION#v}"
elif [[ -n "${FROGG_REF:-}" ]]; then
  install_source "$FROGG_REF"
else
  echo "error: set FROGG_VERSION (a released version) or FROGG_REF (a branch, tag or commit)" >&2
  exit 1
fi

if ! "$dest/bin/frogg" plugins index --help 2>/dev/null | grep -q "sign"; then
  echo "error: this frogg CLI has no 'plugins index' commands; use a newer FROGG_VERSION or FROGG_REF" >&2
  exit 1
fi
echo "frogg $("$dest/bin/frogg" --version) ready at $dest/bin/frogg"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$dest/bin" >>"$GITHUB_PATH"
fi
