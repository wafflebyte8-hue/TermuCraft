#!/data/data/com.termux/files/usr/bin/bash
# TermuCraft removal script

set -euo pipefail

UI_DIR="$HOME/TermuCraft"
DEFAULT_SERVER_DIR="$HOME/termucraft-server"

G='\033[0;32m'
Y='\033[1;33m'
R='\033[0;31m'
D='\033[2m'
N='\033[0m'

ok()   { echo -e "${G}[ok]${N} $1"; }
warn() { echo -e "${Y}[!]${N} $1"; }
die()  { echo -e "${R}[x]${N} $1"; exit 1; }

json_get() {
  local file="$1"
  local path="$2"
  [ -f "$file" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const path=process.argv[2].split('.');let cur=data;for (const key of path) cur = cur == null ? undefined : cur[key];process.stdout.write(cur == null ? '' : String(cur));" "$file" "$path"
  fi
}

prompt_yes_no() {
  local label="$1"
  local default="${2:-N}"
  local answer=""
  if [ "$default" = "Y" ]; then
    read -r -p "  ${label} [Y/n]: " answer
    [[ ! "$answer" =~ ^[Nn]$ ]]
  else
    read -r -p "  ${label} [y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]]
  fi
}

banner() {
  clear
  echo ""
  echo -e "${R}  TermuCraft Removal${N}"
  echo -e "${D}  Remove the panel, its launchers, and optionally the server directory.${N}"
  echo ""
}

stop_running_instances() {
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t termucraft 2>/dev/null; then
    tmux kill-session -t termucraft || true
    ok "Stopped tmux session 'termucraft'"
  fi

  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$UI_DIR/server.js" 2>/dev/null || true
  fi
}

main() {
  local server_dir remove_server
  banner

  if [ ! -d "$UI_DIR" ] && [ ! -f "$HOME/termucraft" ] && [ ! -f "$HOME/start-termucraft.sh" ]; then
    warn "TermuCraft does not appear to be installed."
    exit 0
  fi

  server_dir="$(json_get "$UI_DIR/config.json" "serverDir" || true)"
  server_dir="${server_dir:-$DEFAULT_SERVER_DIR}"
  remove_server=0

  echo -e "  ${D}Panel directory${N}  $UI_DIR"
  echo -e "  ${D}Server directory${N} $server_dir"
  echo ""

  if [ -d "$server_dir" ]; then
    prompt_yes_no "Remove the Minecraft server directory too?" N && remove_server=1
  fi

  echo ""
  echo -e "  ${Y}This will remove:${N}"
  echo -e "    ${D}$UI_DIR${N}"
  echo -e "    ${D}$HOME/termucraft${N}"
  echo -e "    ${D}$HOME/termucraft-bg${N}"
  echo -e "    ${D}$HOME/start-termucraft.sh${N}"
  echo -e "    ${D}$HOME/start-termucraft-bg.sh${N}"
  echo -e "    ${D}$HOME/uninstall-termucraft.sh${N}"
  [ "$remove_server" -eq 1 ] && echo -e "    ${R}$server_dir${N}"
  echo ""

  prompt_yes_no "Continue with removal?" N || exit 0

  stop_running_instances

  rm -rf "$UI_DIR"
  rm -f \
    "$HOME/termucraft" \
    "$HOME/termucraft-bg" \
    "$HOME/start-termucraft.sh" \
    "$HOME/start-termucraft-bg.sh" \
    "$HOME/uninstall-termucraft.sh"
  ok "Panel files removed"

  if [ "$remove_server" -eq 1 ]; then
    rm -rf "$server_dir"
    ok "Server directory removed"
  else
    echo -e "${D}Server directory kept at $server_dir${N}"
  fi

  echo ""
  echo -e "${G}TermuCraft has been removed.${N}"
  echo ""
}

main "$@"
