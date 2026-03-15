#!/data/data/com.termux/files/usr/bin/bash
# TermuCraft uninstall script

set -euo pipefail

G='\033[0;32m'
A='\033[1;33m'
R='\033[0;31m'
D='\033[2m'
N='\033[0m'

log()  { echo -e "${G}[OK]${N} $1"; }
warn() { echo -e "${A}[!]${N} $1"; }
info() { echo -e "${D}$1${N}"; }

UI_DIR="$HOME/TermuCraft"
MC_DIR="$HOME/minecraft"

clear
echo ""
echo -e "${R}  TermuCraft Uninstall${N}"
echo -e "${D}  This removes the panel and launch scripts.${N}"
echo ""

if [ ! -d "$UI_DIR" ] && [ ! -f "$HOME/start-termucraft.sh" ]; then
  warn "TermuCraft does not appear to be installed."
  exit 0
fi

REMOVE_WORLD=0
if [ -d "$MC_DIR" ]; then
  echo -e "  ${A}World data found at ~/minecraft/${N}"
  read -r -p "  Remove the Minecraft server directory too? [y/N]: " world_ans
  if [[ "$world_ans" =~ ^[Yy]$ ]]; then
    REMOVE_WORLD=1
  fi
fi

echo ""
echo -e "  ${A}About to remove:${N}"
echo -e "    ${D}~/TermuCraft/${N}"
echo -e "    ${D}~/start-termucraft.sh${N}"
echo -e "    ${D}~/start-termucraft-bg.sh${N}"
echo -e "    ${D}~/uninstall-termucraft.sh${N}"
[ "$REMOVE_WORLD" -eq 1 ] && echo -e "    ${R}~/minecraft/${N}"
echo ""
read -r -p "  Continue? [y/N]: " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || exit 0

if command -v tmux >/dev/null 2>&1 && tmux has-session -t termucraft 2>/dev/null; then
  tmux kill-session -t termucraft || true
  log "Stopped tmux session 'termucraft'"
fi

rm -rf "$UI_DIR"
rm -f "$HOME/start-termucraft.sh" "$HOME/start-termucraft-bg.sh" "$HOME/uninstall-termucraft.sh"
log "Removed TermuCraft files"

if [ "$REMOVE_WORLD" -eq 1 ]; then
  rm -rf "$MC_DIR"
  log "Removed ~/minecraft/"
else
  info "World data kept at ~/minecraft/"
fi

echo ""
echo -e "${G}==============================================${N}"
echo -e "${G}  TermuCraft removed${N}"
echo -e "${G}==============================================${N}"
echo ""
