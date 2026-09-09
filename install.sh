#!/usr/bin/env bash
#
# redline installer/bootstrap.
#
#   install.sh                 install the app and start the daemon, wait for health
#   install.sh --ensure-daemon make sure the daemon is running and current.
#                              Used by the pi/opencode tools.
#   install.sh --update        same as ensure-daemon (updates to the latest release
#                              when one exists; pulls the source checkout in source mode)
#   install.sh --from-source   run the daemon from source instead of the prebuilt
#                              release binary (needs git + bun or node 22+)
#   install.sh --with-pi       also wire ~/.pi/agent/settings.json (extension + skill)
#   install.sh --with-opencode also symlink the plugin + register the skill for opencode
#
# Binary mode (default): downloads the prebuilt release binary into $REDLINE_HOME/bin.
# Only needs curl + tar. Source mode (running from a checkout, REDLINE_APP set,
# or --from-source): needs git + bun (or node 22+); the pi/opencode wiring always
# clones the source to $REDLINE_HOME/app because the extension/plugin live there.
#
# Environment:
#   REDLINE_HOME     data home (default ~/.redline); binary lands in $REDLINE_HOME/bin
#   REDLINE_APP      app directory; setting it forces source mode
#   REDLINE_REPO     git URL to clone (default: https://github.com/codenamegary/redline.git)
#   REDLINE_VERSION  pin a release tag (e.g. v0.2.0; default: latest release)
#   REDLINE_RELEASE_BASE  override the release download base (default: GitHub releases)
#   REDLINE_PORT / REDLINE_HOST  passed through to the daemon
#
set -euo pipefail

REDLINE_HOME="${REDLINE_HOME:-$HOME/.redline}"
REPO_URL="${REDLINE_REPO:-https://github.com/codenamegary/redline.git}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

REPO_SLUG="$(printf '%s' "$REPO_URL" | sed -e 's#.*github.com/##' -e 's#\.git$##')"
RELEASE_BASE="${REDLINE_RELEASE_BASE:-https://github.com/$REPO_SLUG/releases}"
BIN_DIR="$REDLINE_HOME/bin"
BIN_PATH="$BIN_DIR/redline"
VERSION_FILE="$BIN_DIR/VERSION"

# ---------- locate the app directory / pick the mode ----------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

MODE="install"
FROM_SOURCE=0
WIRE_PI=0
WIRE_OPENCODE=0
for arg in "$@"; do
  case "$arg" in
    --ensure-daemon)  MODE="ensure-daemon" ;;
    --update)         MODE="update" ;;
    --from-source)    FROM_SOURCE=1 ;;
    --with-pi)        WIRE_PI=1 ;;
    --with-opencode)  WIRE_OPENCODE=1 ;;
    --help|-h)
      sed -n '2,26p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

if [ -n "${REDLINE_APP:-}" ]; then
  APP_DIR="$REDLINE_APP"
  FROM_SOURCE=1
elif [ -n "$SCRIPT_DIR" ] && [ "$SCRIPT_DIR" != "$REDLINE_HOME/app" ] && [ -f "$SCRIPT_DIR/packages/server/src/main.ts" ]; then
  APP_DIR="$SCRIPT_DIR"
  FROM_SOURCE=1
else
  APP_DIR="$REDLINE_HOME/app"
fi

# ---------- runtime: bun, or node 22+, or bootstrap a user-local bun (source mode) ----------

BUN=""
NODE_OK=0

if [ "$FROM_SOURCE" -eq 1 ]; then
  have curl || die "curl is required to install redline"
  if have bun; then
    BUN="$(command -v bun)"
  elif have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; then
    NODE_OK=1
  fi

  if [ -z "$BUN" ] && [ "$NODE_OK" -ne 1 ]; then
    say "no bun and no node 22+ found — installing bun to ~/.bun (user-local, no sudo)"
    [ -f "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash
    [ -x "$HOME/.bun/bin/bun" ] || die "bun installation failed; install bun (https://bun.sh) or node 22+ and re-run"
    export PATH="$HOME/.bun/bin:$PATH"
    BUN="$HOME/.bun/bin/bun"
  fi
fi

# ---------- server discovery helpers ----------

server_port() {
  echo "${REDLINE_PORT:-4739}"
}

health_url() { echo "http://127.0.0.1:$(server_port)/api/v1/health"; }

healthy() { curl -fsS --max-time 2 "$(health_url)" >/dev/null 2>&1; }

running_version() {
  curl -fsS --max-time 2 "$(health_url)" 2>/dev/null | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' || true
}

stop_daemon() {
  pkill -f "src/main.ts serve" 2>/dev/null || true
  pkill -f "bin/redline serve" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "src/main.ts serve" >/dev/null 2>&1 && continue
    pgrep -f "bin/redline serve" >/dev/null 2>&1 && continue
    break
  done
}

start_daemon() {
  mkdir -p "$REDLINE_HOME"
  if [ "$FROM_SOURCE" -eq 1 ]; then
    (
      cd "$APP_DIR"
      if [ -n "$BUN" ]; then
        nohup "$BUN" run packages/server/src/main.ts serve >> "$REDLINE_HOME/server.log" 2>&1 &
      else
        nohup npx -y tsx packages/server/src/main.ts serve >> "$REDLINE_HOME/server.log" 2>&1 &
      fi
      disown 2>/dev/null || true
    )
  else
    nohup "$BIN_PATH" serve --home "$REDLINE_HOME" >> "$REDLINE_HOME/server.log" 2>&1 &
    disown 2>/dev/null || true
  fi
}

wait_health() {
  local attempts="${1:-120}"
  for _ in $(seq 1 "$attempts"); do
    healthy && return 0
    sleep 0.5
  done
  warn "daemon did not become healthy; last log lines:"
  [ -f "$REDLINE_HOME/server.log" ] && tail -n 8 "$REDLINE_HOME/server.log" >&2
  return 1
}

# ---------- release binary ----------

installed_version() {
  if [ -f "$VERSION_FILE" ]; then tr -d '[:space:]' < "$VERSION_FILE"; fi
}

latest_tag() {
  local target
  target="$(curl -fsSLI --max-time 10 -o /dev/null -w '%{url_effective}' "$RELEASE_BASE/latest" 2>/dev/null | sed 's#.*/tag/##')" || return 0
  case "$target" in
    v[0-9]*) printf '%s' "$target" ;;
  esac
}

verify_checksums() {
  local dir="$1" tarball="$2"
  (
    cd "$dir" || return 1
    if ! have sha256sum && ! have shasum; then
      warn "no sha256 tool found; skipping checksum verification"
      return 0
    fi
    local expected actual
    # checksums.txt lists every release tarball; verify the one we downloaded.
    # Entries may be "name" or "./name" depending on how they were generated.
    expected="$(awk -v t="$tarball" '$2 == t || $2 == "./" t { print $1; exit }' checksums.txt 2>/dev/null)"
    if [ -z "$expected" ]; then
      warn "checksums.txt has no entry for $tarball; skipping checksum verification"
      return 0
    fi
    if have sha256sum; then
      actual="$(sha256sum "$tarball" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$tarball" | awk '{print $1}')"
    fi
    if [ "$actual" != "$expected" ]; then
      echo "expected $expected" >&2
      echo "got      $actual" >&2
      return 1
    fi
  )
}

download_release() {
  local version="$1" platform tmp
  [ -n "$version" ] || die "no release version to download"
  have tar || die "tar is required to install the redline binary"
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  case "$platform" in
    linux-x86_64)   platform="linux-x64" ;;
    linux-aarch64)  platform="linux-arm64" ;;
    linux-arm64)    platform="linux-arm64" ;;
    darwin-x86_64)  platform="darwin-x64" ;;
    darwin-arm64)   platform="darwin-arm64" ;;
    *) die "no prebuilt binary for $platform — run install.sh --from-source instead" ;;
  esac
  tmp="$(mktemp -d)"
  say "downloading redline v$version ($platform)"
  curl -fsSL "$RELEASE_BASE/download/v$version/redline-$version-$platform.tar.gz" -o "$tmp/redline-$version-$platform.tar.gz" \
    || die "could not download redline v$version for $platform from $RELEASE_BASE"
  if curl -fsSL "$RELEASE_BASE/download/v$version/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null; then
    verify_checksums "$tmp" "redline-$version-$platform.tar.gz" || die "checksum verification failed for redline v$version"
  else
    warn "could not download checksums.txt; skipping checksum verification"
  fi
  tar -xzf "$tmp/redline-$version-$platform.tar.gz" -C "$tmp"
  mkdir -p "$BIN_DIR"
  mv "$tmp/redline-$version-$platform/redline" "$BIN_PATH"
  printf '%s\n' "$version" > "$VERSION_FILE"
  rm -rf "$tmp"
}

# ---------- source checkout ----------

ensure_app() {
  if [ -f "$APP_DIR/packages/server/src/main.ts" ]; then
    return 0
  fi
  have git || die "git is required to install redline (apt install git / brew install git)"
  say "cloning redline into $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$APP_DIR" >&2
  [ -f "$APP_DIR/packages/server/src/main.ts" ] || die "clone succeeded but $APP_DIR/packages/server/src/main.ts is missing"
}

ensure_deps() {
  say "installing dependencies in $APP_DIR"
  (
    cd "$APP_DIR"
    if [ -n "$BUN" ]; then
      "$BUN" install >/dev/null 2>&1 || "$BUN" install
    else
      npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
    fi
  )
}

app_head() {
  git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true
}

refresh_app() {
  [ -d "$APP_DIR/.git" ] || return 0
  if ! git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1; then
    warn "could not update $APP_DIR (local changes?) — keeping the current copy"
  fi
}

# ---------- daemon lifecycle ----------

ensure_daemon_source() {
  local before after
  before="$(app_head)"
  refresh_app
  after="$(app_head)"
  ensure_deps

  if healthy; then
    if [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]; then
      say "restarting daemon after update"
      stop_daemon
      start_daemon
      wait_health || die "daemon failed to restart (see $REDLINE_HOME/server.log)"
      say "redline ready: $(health_url)"
    else
      say "redline already running: $(health_url)"
    fi
    return 0
  fi
  stop_daemon
  say "starting redline daemon"
  start_daemon
  wait_health || die "daemon failed to start (see $REDLINE_HOME/server.log)"
  say "redline ready: $(health_url)"
}

ensure_daemon_binary() {
  local desired installed running
  desired="${REDLINE_VERSION:-$(latest_tag)}"
  desired="${desired#v}"
  installed="$(installed_version)"

  if [ -x "$BIN_PATH" ] && [ -n "$installed" ] && [ -n "$desired" ] && [ "$installed" != "$desired" ]; then
    download_release "$desired"
    installed="$desired"
  elif [ ! -x "$BIN_PATH" ] || [ -z "$installed" ]; then
    if [ -n "$desired" ]; then
      download_release "$desired"
      installed="$desired"
    else
      die "no redline binary installed and the latest release could not be resolved; set REDLINE_VERSION=<tag> and retry, or run install.sh --from-source"
    fi
  else
    say "redline binary v$installed is up to date"
  fi

  running="$(running_version)"
  if healthy && { [ -z "$running" ] || [ "$running" = "$installed" ]; }; then
    say "redline already running: $(health_url)${running:+ (v$running)}"
    return 0
  fi
  if healthy; then
    say "upgrading daemon v$running -> v$installed"
    stop_daemon
  else
    stop_daemon
    say "starting redline daemon"
  fi
  start_daemon
  wait_health || die "daemon failed to start (see $REDLINE_HOME/server.log)"
  say "redline ready: $(health_url) (v$(running_version))"
}

# ---------- harness wiring (needs the source checkout) ----------

run_json_edit() {
  local script="$1"; shift
  if [ -n "$BUN" ]; then
    "$BUN" "$script" "$@"
  else
    node "$script" "$@"
  fi
}

wire_pi() {
  say "wiring pi (~/.pi/agent/settings.json)"
  local tmp
  tmp="$(mktemp /tmp/redline-pi-XXXXXX.js)"
  cat > "$tmp" <<'EOF'
const fs = require("node:fs")
const path = require("node:path")
const file = process.argv[2]
const app = process.argv[3]
let json = {}
try { json = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
const extensions = new Set(json.extensions ?? [])
const skills = new Set(json.skills ?? [])
extensions.add(path.join(app, "packages", "server", "src", "pi", "redline.extension.ts"))
skills.add(path.join(app, "skills", "redline"))
json.extensions = [...extensions]
json.skills = [...skills]
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n")
console.log("pi settings updated: " + file)
EOF
  run_json_edit "$tmp" "$HOME/.pi/agent/settings.json" "$APP_DIR"
  rm -f "$tmp"
  say "pi: restart it or run /reload, then try any redline tool"
}

wire_opencode() {
  say "wiring opencode"
  local plugin_dir plugin_target
  plugin_dir="$HOME/.config/opencode/plugin"
  mkdir -p "$plugin_dir"
  plugin_target="$plugin_dir/redline.ts"
  ln -sfn "$APP_DIR/packages/server/src/opencode/redline.plugin.ts" "$plugin_target"
  say "plugin linked: $plugin_target -> $APP_DIR/packages/server/src/opencode/redline.plugin.ts"

  if [ ! -d "$HOME/.config/opencode/node_modules/@opencode-ai/plugin" ]; then
    say "installing @opencode-ai/plugin into ~/.config/opencode"
    (
      cd "$HOME/.config/opencode"
      if [ -n "$BUN" ]; then "$BUN" add @opencode-ai/plugin >/dev/null 2>&1 || "$BUN" add @opencode-ai/plugin
      else npm install @opencode-ai/plugin --no-audit --no-fund >/dev/null 2>&1 || npm install @opencode-ai/plugin --no-audit --no-fund; fi
    ) || warn "could not install @opencode-ai/plugin automatically; run: cd ~/.config/opencode && npm i @opencode-ai/plugin"
  fi

  local tmp
  tmp="$(mktemp /tmp/redline-opencode-XXXXXX.js)"
  cat > "$tmp" <<'EOF'
const fs = require("node:fs")
const path = require("node:path")
const file = process.argv[2]
const app = process.argv[3]
let json = {}
const exists = fs.existsSync(file)
try { json = exists ? JSON.parse(fs.readFileSync(file, "utf8")) : {} } catch {
  console.log("could not parse " + file + " (comments? jsonc?) — add this manually:")
  console.log('  "skills": { "paths": [' + JSON.stringify(path.join(app, "skills")) + '] }')
  process.exit(0)
}
const paths = new Set(json.skills?.paths ?? [])
paths.add(path.join(app, "skills"))
json.skills = { ...(json.skills ?? {}), paths: [...paths] }
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n")
console.log("opencode config updated: " + file)
EOF
  run_json_edit "$tmp" "$HOME/.config/opencode/opencode.jsonc" "$APP_DIR"
  rm -f "$tmp"
  say "opencode: restart sessions to pick up the plugin and skill"
}

# ---------- main ----------

if [ "$FROM_SOURCE" -eq 1 ]; then
  [ -f "$APP_DIR/packages/server/src/main.ts" ] || die "no redline app at $APP_DIR (set REDLINE_APP or run install.sh from a checkout)"
else
  have curl || die "curl is required to install redline"
fi

case "$MODE" in
  ensure-daemon|update|install)
    if [ "$FROM_SOURCE" -eq 1 ]; then
      ensure_daemon_source
    else
      ensure_daemon_binary
    fi
    ;;
esac

if [ "$WIRE_PI" -eq 1 ] || [ "$WIRE_OPENCODE" -eq 1 ]; then
  ensure_app
fi
if [ "$WIRE_PI" -eq 1 ]; then wire_pi; fi
if [ "$WIRE_OPENCODE" -eq 1 ]; then wire_opencode; fi

if [ "$FROM_SOURCE" -eq 1 ]; then
  label="source ($(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown))"
else
  label="binary (v$(installed_version))"
fi
say ""
say "redline is ready ☕"
say "  app:      $APP_DIR"
say "  daemon:   $label"
say "  gallery:  http://127.0.0.1:$(server_port)/"
say "  home:     $REDLINE_HOME"
say "  log:      $REDLINE_HOME/server.log"
