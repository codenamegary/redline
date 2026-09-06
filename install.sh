#!/usr/bin/env bash
#
# redline installer/bootstrap.
#
#   install.sh                 ensure the app (clone to ~/.redline/app if needed),
#                              ensure deps + runtime, start the daemon, wait for health
#   install.sh --ensure-daemon pull latest (if git), refresh deps, start or restart
#                              the daemon when needed. Used by the pi/opencode tools.
#   install.sh --update        same as ensure-daemon after ensure_app (clone if missing)
#   install.sh --with-pi       also wire ~/.pi/agent/settings.json (extension + skill)
#   install.sh --with-opencode also symlink the plugin + register the skill for opencode
#
# Environment:
#   REDLINE_HOME   data home (default ~/.redline)
#   REDLINE_APP    app directory (default: this checkout if run from one, else ~/.redline/app)
#   REDLINE_REPO   git URL to clone (default: https://github.com/codenamegary/redline.git)
#   REDLINE_PORT / REDLINE_HOST  passed through to the daemon
#
set -euo pipefail

REDLINE_HOME="${REDLINE_HOME:-$HOME/.redline}"
REPO_URL="${REDLINE_REPO:-https://github.com/codenamegary/redline.git}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- locate the app directory ----------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

if [ -n "${REDLINE_APP:-}" ]; then
  APP_DIR="$REDLINE_APP"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/main.ts" ]; then
  APP_DIR="$SCRIPT_DIR"
else
  APP_DIR="$REDLINE_HOME/app"
fi

MODE="install"
WIRE_PI=0
WIRE_OPENCODE=0
for arg in "$@"; do
  case "$arg" in
    --ensure-daemon)  MODE="ensure-daemon" ;;
    --update)         MODE="update" ;;
    --with-pi)        WIRE_PI=1 ;;
    --with-opencode)  WIRE_OPENCODE=1 ;;
    --help|-h)
      sed -n '2,16p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

[ -n "${SCRIPT_DIR:-}" ] || true

# ---------- runtime: bun, or node 22+, or bootstrap a user-local bun ----------

BUN=""
NODE_OK=0

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

# ---------- server discovery helpers ----------

server_port() {
  echo "${REDLINE_PORT:-4739}"
}

health_url() { echo "http://127.0.0.1:$(server_port)/api/v1/health"; }

healthy() { curl -fsS --max-time 2 "$(health_url)" >/dev/null 2>&1; }

stop_daemon() {
  pkill -f "src/main.ts serve" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "src/main.ts serve" >/dev/null 2>&1 || break
    sleep 0.25
  done
}

start_daemon() {
  mkdir -p "$REDLINE_HOME"
  (
    cd "$APP_DIR"
    if [ -n "$BUN" ]; then
      nohup "$BUN" run src/main.ts serve >> "$REDLINE_HOME/server.log" 2>&1 &
    else
      nohup npx -y tsx src/main.ts serve >> "$REDLINE_HOME/server.log" 2>&1 &
    fi
    disown 2>/dev/null || true
  )
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

# ---------- steps ----------

ensure_app() {
  if [ -f "$APP_DIR/src/main.ts" ]; then
    return 0
  fi
  have git || die "git is required to install redline (apt install git / brew install git)"
  say "cloning redline into $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$APP_DIR" >&2
  [ -f "$APP_DIR/src/main.ts" ] || die "clone succeeded but $APP_DIR/src/main.ts is missing"
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

ensure_daemon() {
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
extensions.add(path.join(app, "src", "pi", "redline.extension.ts"))
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
  ln -sfn "$APP_DIR/src/opencode/redline.plugin.ts" "$plugin_target"
  say "plugin linked: $plugin_target -> $APP_DIR/src/opencode/redline.plugin.ts"

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

case "$MODE" in
  ensure-daemon)
    [ -f "$APP_DIR/src/main.ts" ] || die "no redline app at $APP_DIR (set REDLINE_APP or run install.sh from a checkout)"
    ensure_daemon
    ;;
  update)
    ensure_app
    ensure_daemon
    ;;
  install)
    ensure_app
    ensure_daemon
    ;;
esac

if [ "$WIRE_PI" -eq 1 ]; then wire_pi; fi
if [ "$WIRE_OPENCODE" -eq 1 ]; then wire_opencode; fi

commit="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
say ""
say "redline is ready ☕"
say "  app:      $APP_DIR ($commit)"
say "  gallery:  http://127.0.0.1:$(server_port)/"
say "  home:     $REDLINE_HOME"
say "  log:      $REDLINE_HOME/server.log"
