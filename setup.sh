#!/data/data/com.termux/files/usr/bin/bash
# TermuCraft install / update wizard for Termux

set -euo pipefail

APP_NAME="TermuCraft"
APP_VERSION="0.1.0"
REPO_RAW="https://raw.githubusercontent.com/wafflebyte8-hue/TermuCraft/main"
UI_DIR="$HOME/TermuCraft"
DEFAULT_SERVER_DIR="$HOME/termucraft-server"
TMP_DIR="$(mktemp -d "$HOME/.termucraft-stage.XXXXXX")"

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

G='\033[0;32m'
C='\033[0;36m'
Y='\033[1;33m'
R='\033[0;31m'
D='\033[2m'
N='\033[0m'

cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

ok()   { echo -e "${G}[ok]${N} $1"; }
note() { echo -e "${C}[..]${N} $1"; }
warn() { echo -e "${Y}[!]${N} $1"; }
die()  { echo -e "${R}[x]${N} $1"; exit 1; }

line() {
  printf '%b\n' "${D}------------------------------------------------------------${N}"
}

banner() {
  clear
  echo ""
  echo -e "${G}-------------------------------------------------------------${N}"
  echo -e "${G} ______                          _____               ___  __ ${N}"
  echo -e "${G}/_  __/ ___   ____  __ _  __ __ / ___/  ____ ___ _  / _/ / /${N}"
  echo -e "${G} / /   / -_) / __/ /  ' \/ // // /__   / __// _. / / _/ / __/${N}"
  echo -e "${G}/_/    \__/ /_/   /_/_/_/\_,_/ \___/  /_/   \_,_/ /_/   \__/ ${N}"
  echo -e "${D}  Version ${APP_VERSION} · Termux-first Minecraft control deck${N}"
  echo -e "${G}-------------------------------------------------------------${N}"
  echo ""
}

section() {
  echo ""
  line
  echo -e "${G}$1${N}"
  line
}

prompt_default() {
  local label="$1"
  local default="$2"
  local answer=""
  read -r -p "  ${label} [${default}]: " answer
  printf '%s' "${answer:-$default}"
}

prompt_yes_no() {
  local label="$1"
  local default="${2:-Y}"
  local answer=""
  if [ "$default" = "Y" ]; then
    read -r -p "  ${label} [Y/n]: " answer
    [[ ! "$answer" =~ ^[Nn]$ ]]
  else
    read -r -p "  ${label} [y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]]
  fi
}

prompt_secret_pair() {
  local first_label="$1"
  local second_label="$2"
  local first=""
  local second=""
  while :; do
    read -r -s -p "  ${first_label}: " first
    echo ""
    read -r -s -p "  ${second_label}: " second
    echo ""
    [ -n "$first" ] || { warn "Password cannot be empty."; continue; }
    [ "$first" = "$second" ] && break
    warn "Passwords did not match."
  done
  printf '%s' "$first"
}

normalize_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ]
}

normalize_memory() {
  local value="${1^^}"
  [[ "$value" =~ ^[0-9]+[MG]$ ]] || return 1
  printf '%s' "$value"
}

suggest_memory() {
  local total_mb suggested
  total_mb="$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}')"
  if [ -n "${total_mb:-}" ] && [ "$total_mb" -gt 0 ]; then
    suggested=$((total_mb / 2))
    suggested=$(((suggested / 512) * 512))
    [ "$suggested" -lt 512 ] && suggested=512
    printf '%sM' "$suggested"
    return
  fi
  printf '1G'
}

json_get() {
  local file="$1"
  local path="$2"
  [ -f "$file" ] || return 1
  node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const path=process.argv[2].split('.');let cur=data;for (const key of path) cur = cur == null ? undefined : cur[key];process.stdout.write(cur == null ? '' : String(cur));" "$file" "$path"
}

require_termux() {
  if [ ! -d "/data/data/com.termux" ]; then
    warn "This does not look like Termux."
    prompt_yes_no "Continue anyway?" N || exit 1
  fi
}

fetch_payload() {
  section "Stage 1 · Fetching TermuCraft payload"
  mkdir -p "$TMP_DIR" || die "Could not create staging directory."
  for file in "${FILES[@]}"; do
    note "Downloading ${file}"
    curl -fsSL "$REPO_RAW/$file" -o "$TMP_DIR/$file" || die "Failed to download $file"
  done
  ok "Payload staged in $TMP_DIR"
}

verify_payload() {
  section "Stage 2 · Verifying payload"
  if ! command -v sha256sum >/dev/null 2>&1; then
    warn "sha256sum is unavailable, skipping verification."
    return
  fi
  if (
    cd "$TMP_DIR"
    sha256sum -c checksums.sha256 >/dev/null
  ); then
    ok "Checksum verification passed"
  else
    warn "Checksum verification failed. Review the repo state if this was unexpected."
  fi
}

install_runtime() {
  section "Stage 3 · Installing runtime"
  pkg update -y >/dev/null || warn "pkg update returned warnings."
  pkg install -y openjdk-21 nodejs-lts curl openssl-tool git >/dev/null || die "Failed to install the required runtime packages."
  ok "Java ready: $(java -version 2>&1 | head -1)"
  ok "Node ready: $(node --version) / npm $(npm --version)"

  if ! command -v tmux >/dev/null 2>&1; then
    if prompt_yes_no "Install tmux for background launchers?" Y; then
      pkg install -y tmux >/dev/null || warn "tmux install failed."
    fi
  else
    ok "tmux already available"
  fi

  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock || true
    ok "Wake lock requested"
  else
    warn "termux-wake-lock is unavailable. Install Termux:API if you want wake-lock support."
  fi
}

collect_install_plan() {
  KEEP_EXISTING_CONFIG=0
  KEEP_EXISTING_AUTH=0
  SERVER_DIR="$DEFAULT_SERVER_DIR"
  MC_RAM="$(suggest_memory)"
  PANEL_PORT="8080"
  ENABLE_HTTPS=0
  HTTPS_PORT="8443"
  HTTPS_CERT_DIR="$UI_DIR/certs"
  HTTPS_CERT_PATH="$HTTPS_CERT_DIR/cert.pem"
  HTTPS_KEY_PATH="$HTTPS_CERT_DIR/key.pem"
  ADMIN_USER="admin"
  ADMIN_PASS=""

  section "Stage 4 · Building the install plan"

  if [ -f "$UI_DIR/config.json" ] && [ -f "$UI_DIR/auth.json" ]; then
    ok "Existing TermuCraft install detected."
    if prompt_yes_no "Keep the current panel config?" Y; then
      KEEP_EXISTING_CONFIG=1
      SERVER_DIR="$(json_get "$UI_DIR/config.json" "serverDir" || printf '%s' "$DEFAULT_SERVER_DIR")"
      MC_RAM="$(json_get "$UI_DIR/config.json" "memory" || printf '%s' "$(suggest_memory)")"
      PANEL_PORT="$(json_get "$UI_DIR/config.json" "uiPort" || printf '8080')"
      if [ "$(json_get "$UI_DIR/config.json" "httpsEnabled" || printf 'false')" = "true" ]; then
        ENABLE_HTTPS=1
        HTTPS_PORT="$(json_get "$UI_DIR/config.json" "httpsPort" || printf '8443')"
        HTTPS_CERT_PATH="$(json_get "$UI_DIR/config.json" "httpsCertPath" || printf '%s' "$HTTPS_CERT_PATH")"
        HTTPS_KEY_PATH="$(json_get "$UI_DIR/config.json" "httpsKeyPath" || printf '%s' "$HTTPS_KEY_PATH")"
      fi
      note "Current config will be preserved."
    fi

    if prompt_yes_no "Keep the current panel login?" Y; then
      KEEP_EXISTING_AUTH=1
      ADMIN_USER="$(json_get "$UI_DIR/auth.json" "username" || printf 'admin')"
      note "Current login will be preserved for user: $ADMIN_USER"
    fi
  fi

  if [ "$KEEP_EXISTING_CONFIG" -eq 0 ]; then
    SERVER_DIR="$(prompt_default "Minecraft server directory" "$DEFAULT_SERVER_DIR")"

    while :; do
      PANEL_PORT="$(prompt_default "Panel HTTP port" "8080")"
      normalize_port "$PANEL_PORT" && break
      warn "Enter a valid port between 1 and 65535."
    done

    while :; do
      local_memory="$(prompt_default "Minecraft server RAM" "$(suggest_memory)")"
      if MC_RAM="$(normalize_memory "$local_memory")"; then
        break
      fi
      warn "Use values like 768M, 1G, or 2G."
    done

    if prompt_yes_no "Generate a self-signed HTTPS certificate for the panel?" N; then
      ENABLE_HTTPS=1
      while :; do
        HTTPS_PORT="$(prompt_default "Panel HTTPS port" "8443")"
        normalize_port "$HTTPS_PORT" && break
        warn "Enter a valid port between 1 and 65535."
      done
    fi
  fi

  if [ "$KEEP_EXISTING_AUTH" -eq 0 ]; then
    while :; do
      ADMIN_USER="$(prompt_default "Panel username" "$ADMIN_USER")"
      [ -n "$ADMIN_USER" ] && break
      warn "Username cannot be empty."
    done

    ADMIN_PASS="$(prompt_secret_pair "Panel password" "Confirm password")"
  fi
}

write_config() {
  cat > "$UI_DIR/config.json" <<EOF
{
  "serverJar": "server.jar",
  "serverDir": "$SERVER_DIR",
  "memory": "$MC_RAM",
  "javaPath": "java",
  "uiPort": $PANEL_PORT,
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
}

write_auth() {
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
}

generate_https_cert() {
  [ "$ENABLE_HTTPS" -eq 1 ] || return
  mkdir -p "$HTTPS_CERT_DIR"
  if openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$HTTPS_KEY_PATH" \
    -out "$HTTPS_CERT_PATH" \
    -days 3650 \
    -subj "/CN=TermuCraft" >/dev/null 2>&1; then
    ok "Self-signed HTTPS certificate created"
  else
    warn "HTTPS certificate generation failed. Falling back to HTTP."
    ENABLE_HTTPS=0
    write_config
  fi
}

deploy_payload() {
  section "Stage 5 · Deploying files"
  install -d "$UI_DIR/public" "$UI_DIR/backups" "$SERVER_DIR"
  install -m 0644 "$TMP_DIR/server.js" "$UI_DIR/server.js"
  install -m 0644 "$TMP_DIR/package.json" "$UI_DIR/package.json"
  install -m 0644 "$TMP_DIR/package-lock.json" "$UI_DIR/package-lock.json"
  install -m 0644 "$TMP_DIR/index.html" "$UI_DIR/public/index.html"
  install -m 0644 "$TMP_DIR/style.css" "$UI_DIR/public/style.css"
  install -m 0644 "$TMP_DIR/app.js" "$UI_DIR/public/app.js"
  install -m 0644 "$TMP_DIR/Logo.png" "$UI_DIR/public/Logo.png"
  install -m 0644 "$TMP_DIR/checksums.sha256" "$UI_DIR/.checksums"
  install -m 0755 "$TMP_DIR/uninstall.sh" "$HOME/uninstall-termucraft.sh"
  ok "Application files copied"

  if [ "$KEEP_EXISTING_CONFIG" -eq 0 ]; then
    write_config
    generate_https_cert
    ok "Config written"
  else
    ok "Existing config kept"
  fi

  if [ "$KEEP_EXISTING_AUTH" -eq 0 ]; then
    write_auth
    ok "Panel login written for user: $ADMIN_USER"
  else
    ok "Existing panel login kept for user: $ADMIN_USER"
  fi
}

accept_eula() {
  section "Stage 6 · Minecraft EULA"
  if [ -f "$SERVER_DIR/eula.txt" ] && grep -q '^eula=true$' "$SERVER_DIR/eula.txt" 2>/dev/null; then
    ok "EULA already accepted for $SERVER_DIR"
    return
  fi
  echo -e "  ${Y}Minecraft EULA:${N} https://aka.ms/MinecraftEULA"
  prompt_yes_no "Do you accept the Minecraft EULA?" Y || die "EULA not accepted."
  printf 'eula=true\n' > "$SERVER_DIR/eula.txt"
  ok "eula.txt written"
}

install_node_modules() {
  section "Stage 7 · Installing Node dependencies"
  (
    cd "$UI_DIR"
    npm ci --omit=dev --no-fund --no-audit >/dev/null
  ) || die "npm install failed."
  printf '%s\n' "$APP_VERSION" > "$UI_DIR/.version"
  ok "Dependencies installed"
}

write_launchers() {
  section "Stage 8 · Writing launchers"

  cat > "$HOME/termucraft" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
UI_DIR="${UI_DIR:-$HOME/TermuCraft}"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
cd "$UI_DIR"
MC_VERBOSE=1 node server.js
EOF
  chmod +x "$HOME/termucraft"

  cat > "$HOME/start-termucraft.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec "$HOME/termucraft"
EOF
  chmod +x "$HOME/start-termucraft.sh"

  if command -v tmux >/dev/null 2>&1; then
    cat > "$HOME/termucraft-bg" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
UI_DIR="${UI_DIR:-$HOME/TermuCraft}"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
if tmux has-session -t termucraft 2>/dev/null; then
  echo ""
  echo "  TermuCraft is already running in tmux."
  echo "  Attach with: tmux attach -t termucraft"
  echo ""
else
  tmux new-session -d -s termucraft "cd \"$UI_DIR\" && MC_VERBOSE=1 node server.js"
  echo ""
  echo "  TermuCraft launched in the background."
  echo "  Attach with: tmux attach -t termucraft"
  echo ""
fi
EOF
    chmod +x "$HOME/termucraft-bg"

    cat > "$HOME/start-termucraft-bg.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec "$HOME/termucraft-bg"
EOF
    chmod +x "$HOME/start-termucraft-bg.sh"
  fi

  ok "Launchers created"
}

print_summary() {
  local http_port https_enabled https_port protocol panel_port launch_fg launch_bg summary_user
  http_port="$(json_get "$UI_DIR/config.json" "uiPort" || printf '8080')"
  https_enabled="$(json_get "$UI_DIR/config.json" "httpsEnabled" || printf 'false')"
  https_port="$(json_get "$UI_DIR/config.json" "httpsPort" || printf '8443')"
  summary_user="$(json_get "$UI_DIR/auth.json" "username" || printf 'admin')"
  protocol="http"
  if [ "$https_enabled" = "true" ]; then
    protocol="https"
  fi
  panel_port="$http_port"
  [ "$https_enabled" = "true" ] && panel_port="$https_port"
  launch_fg="$HOME/termucraft"
  launch_bg="$HOME/termucraft-bg"

  section "Ready"
  echo -e "  ${D}Panel files${N}    $UI_DIR"
  echo -e "  ${D}Server files${N}   $SERVER_DIR"
  echo -e "  ${D}Panel login${N}    $summary_user"
  echo -e "  ${D}HTTP port${N}      $http_port"
  if [ "$https_enabled" = "true" ]; then
    echo -e "  ${D}HTTPS port${N}     $https_port"
  fi
  echo -e "  ${D}Foreground${N}     $launch_fg"
  if [ -x "$launch_bg" ]; then
    echo -e "  ${D}Background${N}     $launch_bg"
  fi
  echo ""
  echo -e "${G}Open the panel at ${protocol}://localhost:${panel_port}${N}"
  if [ "$https_enabled" = "true" ]; then
    echo -e "${D}HTTP remains configured on port ${http_port} if you disable HTTPS later.${N}"
  fi
  echo ""
}

main() {
  banner
  require_termux
  fetch_payload
  verify_payload
  install_runtime
  collect_install_plan
  deploy_payload
  accept_eula
  install_node_modules
  write_launchers
  print_summary
}

main "$@"
