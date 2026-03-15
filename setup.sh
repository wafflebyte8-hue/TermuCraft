#!/data/data/com.termux/files/usr/bin/bash
# TermuCraft setup / update script for Termux

set -euo pipefail

G='\033[0;32m'
A='\033[1;33m'
R='\033[0;31m'
B='\033[0;34m'
D='\033[2m'
N='\033[0m'

log()  { echo -e "${G}[OK]${N} $1"; }
warn() { echo -e "${A}[!]${N} $1"; }
err()  { echo -e "${R}[X]${N} $1"; exit 1; }
info() { echo -e "${B}[i]${N} $1"; }
step() {
  echo ""
  echo -e "${G}----------------------------------------${N}"
  echo -e "  $1"
  echo -e "${G}----------------------------------------${N}"
}

TERMUCRAFT_VERSION="0.1.0"
REPO_RAW="https://raw.githubusercontent.com/wafflebyte8-hue/TermuCraft/main"
UI_DIR="$HOME/TermuCraft"
MC_DIR="$HOME/minecraft"
TMP_DIR="$HOME/.termucraft-install.$$"

cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

clear
echo ""
echo -e "${G}  TermuCraft Setup${N}"
echo -e "${D}  Minecraft server panel for Termux${N}"
echo ""

mkdir -p "$TMP_DIR" || err "Could not create temp directory"

if [ ! -d "/data/data/com.termux" ]; then
  warn "This does not look like Termux."
  read -r -p "  Continue anyway? [y/N]: " cont
  [[ "$cont" =~ ^[Yy]$ ]] || exit 1
fi

step "Downloading panel files"

FILES=(
  "server.js"
  "package.json"
  "package-lock.json"
  "index.html"
  "style.css"
  "app.js"
  "Logo.png"
  "uninstall.sh"
  "checksums.sha256"
)

for file in "${FILES[@]}"; do
  info "Downloading $file..."
  curl -fsSL "$REPO_RAW/$file" -o "$TMP_DIR/$file" || err "Failed to download $file"
done

if command -v sha256sum >/dev/null 2>&1; then
  info "Verifying downloads..."
  if (
    cd "$TMP_DIR"
    sha256sum -c checksums.sha256 >/dev/null
  ); then
    log "Downloads verified"
  else
    warn "Checksum verification failed. Continuing anyway."
  fi
else
  warn "sha256sum not found, skipping checksum verification"
fi

step "Installing packages"

pkg update -y 2>/dev/null || warn "pkg update reported warnings"
pkg install -y openjdk-21 nodejs-lts curl openssl-tool >/dev/null || err "Failed to install Java / Node.js / curl / openssl"
log "Java ready: $(java -version 2>&1 | head -1)"
log "Node.js $(node --version) / npm $(npm --version)"

if ! command -v tmux >/dev/null 2>&1; then
  read -r -p "  Install tmux for background sessions? [Y/n]: " dotmux
  if [[ ! "$dotmux" =~ ^[Nn]$ ]]; then
    pkg install -y tmux >/dev/null || warn "tmux install failed"
  fi
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  log "Wake lock enabled"
else
  warn "termux-wake-lock not available. Install Termux:API if you want wake-lock support."
fi

step "Choosing server memory"

TOTAL_MB="$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}')"
if [ -n "$TOTAL_MB" ] && [ "$TOTAL_MB" -gt 0 ]; then
  SUGGESTED_MB=$((TOTAL_MB / 2))
  SUGGESTED_MB=$(((SUGGESTED_MB / 512) * 512))
  [ "$SUGGESTED_MB" -lt 512 ] && SUGGESTED_MB=512
  SUGGESTED="${SUGGESTED_MB}M"
else
  SUGGESTED="1G"
fi

read -r -p "  How much RAM for the Minecraft server? [default: $SUGGESTED]: " ram_input
ram_input="${ram_input:-$SUGGESTED}"
if [[ "$ram_input" =~ ^[0-9]+[MmGg]$ ]]; then
  MC_RAM="${ram_input^^}"
else
  warn "Invalid format '$ram_input', using $SUGGESTED"
  MC_RAM="${SUGGESTED^^}"
fi
log "Server RAM set to $MC_RAM"

step "Creating panel login"

while :; do
  read -r -p "  Web panel username: " ADMIN_USER
  [ -n "$ADMIN_USER" ] && break
  warn "Username cannot be empty"
done

while :; do
  read -r -s -p "  Web panel password: " ADMIN_PASS
  echo ""
  read -r -s -p "  Confirm password: " ADMIN_PASS_CONFIRM
  echo ""
  [ -n "$ADMIN_PASS" ] || { warn "Password cannot be empty"; continue; }
  [ "$ADMIN_PASS" = "$ADMIN_PASS_CONFIRM" ] && break
  warn "Passwords did not match"
done

ENABLE_HTTPS=0
HTTPS_PORT="8443"
HTTPS_CERT_DIR="$UI_DIR/certs"
HTTPS_CERT_PATH="$HTTPS_CERT_DIR/cert.pem"
HTTPS_KEY_PATH="$HTTPS_CERT_DIR/key.pem"

step "HTTPS certificate"

read -r -p "  Enable HTTPS for the web panel with a self-signed certificate? [Y/n]: " https_ans
if [[ ! "$https_ans" =~ ^[Nn]$ ]]; then
  ENABLE_HTTPS=1
  read -r -p "  HTTPS port [default: 8443]: " https_port_input
  HTTPS_PORT="${https_port_input:-8443}"
fi

step "Installing files"

mkdir -p "$UI_DIR/public" "$UI_DIR/backups" "$MC_DIR"
cp "$TMP_DIR/server.js" "$UI_DIR/server.js"
cp "$TMP_DIR/package.json" "$UI_DIR/package.json"
cp "$TMP_DIR/package-lock.json" "$UI_DIR/package-lock.json"
cp "$TMP_DIR/index.html" "$UI_DIR/public/index.html"
cp "$TMP_DIR/style.css" "$UI_DIR/public/style.css"
cp "$TMP_DIR/app.js" "$UI_DIR/public/app.js"
cp "$TMP_DIR/Logo.png" "$UI_DIR/public/Logo.png"
cp "$TMP_DIR/checksums.sha256" "$UI_DIR/.checksums"
cp "$TMP_DIR/uninstall.sh" "$HOME/uninstall-termucraft.sh"
chmod +x "$HOME/uninstall-termucraft.sh"
log "Panel files copied to $UI_DIR"

if [ "$ENABLE_HTTPS" -eq 1 ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    warn "OpenSSL is unavailable. Falling back to HTTP."
    ENABLE_HTTPS=0
  else
    mkdir -p "$HTTPS_CERT_DIR"
    if openssl req -x509 -nodes -newkey rsa:2048 \
      -keyout "$HTTPS_KEY_PATH" \
      -out "$HTTPS_CERT_PATH" \
      -days 3650 \
      -subj "/CN=TermuCraft" >/dev/null 2>&1; then
      log "Self-signed HTTPS certificate generated"
    else
      warn "Failed to generate HTTPS certificate. Falling back to HTTP."
      ENABLE_HTTPS=0
    fi
  fi
fi

cat > "$UI_DIR/config.json" <<EOF
{
  "serverJar": "server.jar",
  "serverDir": "$MC_DIR",
  "memory": "$MC_RAM",
  "javaPath": "java",
  "uiPort": 8080,
  "httpsEnabled": $( [ "$ENABLE_HTTPS" -eq 1 ] && echo "true" || echo "false" ),
  "httpsPort": $HTTPS_PORT,
  "httpsCertPath": "$HTTPS_CERT_PATH",
  "httpsKeyPath": "$HTTPS_KEY_PATH",
  "serverType": "",
  "serverVersion": "",
  "preset": "balanced",
  "autoRestart": true,
  "autoRestartDelaySec": 10,
  "backupRetention": 5,
  "scheduleBackupMinutes": 0,
  "scheduleBroadcastMinutes": 0,
  "scheduleBroadcastMessage": "Scheduled notice from TermuCraft.",
  "scheduleRestartTime": "",
  "motd": "A TermuCraft Minecraft Server",
  "lastDownloadedChecksum": "",
  "lastDownloadedChecksumType": ""
}
EOF
log "config.json written"

ADMIN_USER="$ADMIN_USER" ADMIN_PASS="$ADMIN_PASS" node <<'EOF' > "$UI_DIR/auth.json"
const crypto = require('crypto');
const username = process.env.ADMIN_USER || 'admin';
const password = process.env.ADMIN_PASS || 'changeme';
const salt = crypto.randomBytes(16).toString('hex');
const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
process.stdout.write(JSON.stringify({
  authRequired: true,
  username,
  salt,
  passwordHash,
  bootstrap: false,
  updatedAt: new Date().toISOString(),
}, null, 2));
EOF
log "auth.json written"

echo ""
echo -e "  ${A}Minecraft End User License Agreement (EULA)${N}"
echo -e "  ${B}https://aka.ms/MinecraftEULA${N}"
read -r -p "  Do you accept the Minecraft EULA? [Y/n]: " eula_ans
if [[ "$eula_ans" =~ ^[Nn]$ ]]; then
  err "EULA not accepted"
fi
echo "eula=true" > "$MC_DIR/eula.txt"

step "Installing Node.js dependencies"

cd "$UI_DIR"
npm ci --omit=dev >/dev/null || err "npm install failed"
log "Node.js dependencies installed"

echo "$TERMUCRAFT_VERSION" > "$UI_DIR/.version"
log "Version $TERMUCRAFT_VERSION recorded"

step "Creating launch scripts"

cat > "$HOME/start-termucraft.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
UI_DIR="${UI_DIR:-$HOME/TermuCraft}"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
cd "$UI_DIR"
MC_VERBOSE=1 node server.js
EOF
chmod +x "$HOME/start-termucraft.sh"
log "Created ~/start-termucraft.sh"

if command -v tmux >/dev/null 2>&1; then
cat > "$HOME/start-termucraft-bg.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
UI_DIR="${UI_DIR:-$HOME/TermuCraft}"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
if tmux has-session -t termucraft 2>/dev/null; then
  echo ""
  echo "  TermuCraft is already running."
  echo "  Re-attach: tmux attach -t termucraft"
  echo ""
else
  tmux new-session -d -s termucraft "cd $UI_DIR && MC_VERBOSE=1 node server.js"
  echo ""
  echo "  TermuCraft started in background (tmux: termucraft)"
  echo ""
fi
EOF
  chmod +x "$HOME/start-termucraft-bg.sh"
  log "Created ~/start-termucraft-bg.sh"
fi

echo ""
echo -e "  ${D}Panel path:${N}      $UI_DIR"
echo -e "  ${D}Server path:${N}     $MC_DIR"
echo -e "  ${D}Panel login:${N}     $ADMIN_USER"
echo -e "  ${D}Foreground:${N}      ~/start-termucraft.sh"
command -v tmux >/dev/null 2>&1 && echo -e "  ${D}Background:${N}      ~/start-termucraft-bg.sh"
echo ""
echo -e "${G}==============================================${N}"
echo -e "${G}  Setup complete${N}"
echo -e "${G}==============================================${N}"
echo ""
