#!/usr/bin/env bash
# ============================================================================
#  Sohbet — tek komut kurulum
#
#  Kullanim:
#      sudo bash install.sh
#
#  Opsiyonel ayarlar (komutun basina yazilir):
#      sudo DOMAIN=sohbet.ornek.com bash install.sh   # HTTPS + alan adi ile
#      sudo PORT=4000 bash install.sh                 # farkli uygulama portu
#      sudo LIVEKIT_KUR=0 bash install.sh             # LiveKit'i kurma (zaten varsa)
#      sudo ADMIN_PASSWORD='guclu-bir-sifre' bash install.sh
#
#  Kurulan bilesenler:
#    - Node.js 22+ (yoksa kurulur)
#    - Docker + LiveKit SFU (sesli/görüntülü görüsme; yoksa kurulur)
#    - ffmpeg + yt-dlp (müzik botu icin)
#    - Uygulama bagimliliklari (npm install)
#    - systemd servisi (sohbet)
#    - DOMAIN verildiyse Caddy ile HTTPS ters vekil
#
#  Portlar icin KURULUM.md dosyasina bakin.
# ============================================================================
set -euo pipefail

# ---- Ayarlar (ortam degiskeniyle degistirilebilir) ----
KOK="${KOK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${PORT:-3300}"
DOMAIN="${DOMAIN:-}"
SERVIS_ADI="${SERVIS_ADI:-sohbet}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
LIVEKIT_KUR="${LIVEKIT_KUR:-1}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
LIVEKIT_UDP_PORT="${LIVEKIT_UDP_PORT:-7882}"
ATLA_UFW="${ATLA_UFW:-0}"

# ---- Renkli cikti ----
B='\033[1m'; Y='\033[33m'; G='\033[32m'; R='\033[31m'; N='\033[0m'
adim()  { echo -e "\n${B}==> $*${N}"; }
bilgi() { echo -e "    $*"; }
uyar()  { echo -e "${Y}    ! $*${N}"; }
hata()  { echo -e "${R}    x $*${N}" >&2; }
tamam() { echo -e "${G}    + $*${N}"; }

# ---- Kok kontrolu ----
if [ "$(id -u)" -ne 0 ]; then
  hata "Bu script root (sudo) ile calistirilmali: sudo bash install.sh"
  exit 1
fi

if [ ! -f "$KOK/server/src/index.js" ]; then
  hata "$KOK icinde server/src/index.js bulunamadi."
  hata "Script'i proje kok dizininden calistirin (git clone sonrasi)."
  exit 1
fi

# Servis kullanicisi: sudo ile cagiran kullanici (root degilse)
HEDEF_KULLANICI="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
if [ "$HEDEF_KULLANICI" = "root" ]; then
  uyar "Kurulum root kullanicisi altinda yapiliyor."
fi

echo -e "${B}Sohbet kurulumu${N}"
bilgi "Dizin         : $KOK"
bilgi "Servis adi    : $SERVIS_ADI"
bilgi "Uygulama portu: $PORT"
bilgi "Alan adi      : ${DOMAIN:-yok (yalnizca HTTP)}"
bilgi "Servis kull.  : $HEDEF_KULLANICI"

# ============================================================================
adim "1/8 Sistem paketleri"
# ============================================================================
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git ffmpeg >/dev/null
  tamam "curl, git, ffmpeg hazir"
else
  uyar "apt bulunamadi; bu adim atlandi (Debian/Ubuntu onerilir)"
fi

# yt-dlp (müzik botu icin): sistem paketi eskiyse resmi binary'yi kur
if ! command -v yt-dlp >/dev/null 2>&1; then
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && tamam "yt-dlp kuruldu ($(yt-dlp --version))" \
    || uyar "yt-dlp kurulamadi; müzik botu calismaz"
else
  tamam "yt-dlp zaten kurulu ($(yt-dlp --version))"
fi

# ============================================================================
adim "2/8 Node.js 22+"
# ============================================================================
node_uygun() {
  command -v node >/dev/null 2>&1 || return 1
  local ana
  ana="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "$ana" -ge 22 ]
}
if node_uygun; then
  tamam "Node $(node -v) hazir"
else
  bilgi "Node 22 kuruluyor (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  tamam "Node $(node -v) kuruldu"
fi

# ============================================================================
adim "3/8 Docker ve LiveKit"
# ============================================================================
if ! command -v docker >/dev/null 2>&1; then
  if [ "$LIVEKIT_KUR" = "1" ]; then
    bilgi "Docker kuruluyor (get.docker.com)..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    systemctl enable --now docker >/dev/null 2>&1 || true
    tamam "Docker kuruldu ($(docker --version | cut -d, -f1))"
  else
    uyar "Docker yok ve LIVEKIT_KUR=0 verildi; LiveKit atlandi"
  fi
else
  tamam "Docker hazir ($(docker --version | cut -d, -f1))"
fi

KEYS_DOSYA="$KOK/deploy/livekit.yaml"
if [ "$LIVEKIT_KUR" = "1" ] && command -v docker >/dev/null 2>&1; then
  mkdir -p "$KOK/deploy"
  if [ ! -f "$KEYS_DOSYA" ]; then
    bilgi "LiveKit anahtarlari uretiliyor..."
    # generate-keys ciktisi:  "API Key:  <key>"  ve  "API Secret:  <secret>"
    LK_CIKTI="$(docker run --rm livekit/livekit-server:v1.13.6 generate-keys 2>/dev/null || true)"
    LK_KEY="$(printf '%s\n' "$LK_CIKTI" | sed -n 's/^API Key:[[:space:]]*//p' | head -1)"
    LK_SECRET="$(printf '%s\n' "$LK_CIKTI" | sed -n 's/^API Secret:[[:space:]]*//p' | head -1)"
    if [ -z "${LK_KEY:-}" ] || [ -z "${LK_SECRET:-}" ]; then
      # Yedek yontem: kendi anahtarimizi uret
      LK_KEY="LK$(openssl rand -hex 12)"
      LK_SECRET="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
      uyar "generate-keys calismadi; anahtarlar openssl ile uretildi"
    fi
    sed -e "s|^{KEYS}|  ${LK_KEY}: ${LK_SECRET}|" \
        "$KOK/deploy/livekit.yaml.template" > "$KEYS_DOSYA"
    tamam "deploy/livekit.yaml olusturuldu"
  else
    LK_KEY="$(sed -n 's/^keys:[[:space:]]*$//; s/^  \([^:]*\):.*/\1/p' "$KEYS_DOSYA" | head -1)"
    LK_SECRET="$(sed -n 's/^  [^:]*: \(.*\)$/\1/p' "$KEYS_DOSYA" | head -1)"
    tamam "deploy/livekit.yaml zaten var, mevcut anahtarlar kullanilacak"
  fi
  bilgi "LiveKit baslatiliyor (docker compose)..."
  ( cd "$KOK/deploy" && docker compose up -d ) >/dev/null 2>&1 \
    && tamam "LiveKit calisiyor (port $LIVEKIT_PORT)" \
    || uyar "LiveKit baslatilamadi; 'cd deploy && docker compose logs' ile bakin"
else
  LK_KEY=""; LK_SECRET=""
  uyar "LiveKit kurulmadi; sesli kanallar devre disi kalacak"
fi

# ============================================================================
adim "4/8 .env dosyasi"
# ============================================================================
ENV_DOSYA="$KOK/deploy/.env"
if [ -f "$ENV_DOSYA" ]; then
  # Mevcut dosyadan LiveKit anahtarlarini ve davet kodunu oku
  LK_KEY="$(grep -E '^LIVEKIT_API_KEY=' "$ENV_DOSYA" | cut -d= -f2-)"
  LK_SECRET="$(grep -E '^LIVEKIT_API_SECRET=' "$ENV_DOSYA" | cut -d= -f2-)"
  DAVET="$(grep -E '^INVITE_CODE=' "$ENV_DOSYA" | cut -d= -f2-)"
  tamam "deploy/.env zaten var, korunuyor"
else
  DAVET="$(openssl rand -hex 8)"
  # HOST: alan adi varsa yalnizca yerelden dinle (Caddy one cikar), yoksa herkese acik
  if [ -n "$DOMAIN" ]; then HOST_ADRES="127.0.0.1"; else HOST_ADRES="0.0.0.0"; fi
  if [ -n "$DOMAIN" ]; then
    COOKIE="true"
    LK_PUBLIC="wss://${DOMAIN}/livekit"
  else
    COOKIE="false"
    IP_ADRES="$(hostname -I 2>/dev/null | awk '{print $1}')"
    LK_PUBLIC="ws://${IP_ADRES:-127.0.0.1}:${LIVEKIT_PORT}"
  fi
  cat > "$ENV_DOSYA" <<EOF
PORT=${PORT}
HOST=${HOST_ADRES}
DATA_DIR=${KOK}/data
WEB_DIR=${KOK}/web
COOKIE_SECURE=${COOKIE}
INVITE_CODE=${DAVET}
MAX_UPLOAD_BYTES=8388608
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
LIVEKIT_API_KEY=${LK_KEY}
LIVEKIT_API_SECRET=${LK_SECRET}
LIVEKIT_HTTP_URL=http://127.0.0.1:${LIVEKIT_PORT}
LIVEKIT_PUBLIC_URL=${LK_PUBLIC}
LIVEKIT_WS_URL=ws://127.0.0.1:${LIVEKIT_PORT}
EOF
  chmod 600 "$ENV_DOSYA"
  tamam "deploy/.env olusturuldu (davet kodu: $DAVET)"
fi

# Caddyfile: yalnizca alan adi verildiyse
if [ -n "$DOMAIN" ]; then
  sed -e "s|{DOMAIN}|${DOMAIN}|g" -e "s|{PORT}|${PORT}|g" \
      "$KOK/deploy/Caddyfile.template" > "$KOK/deploy/Caddyfile"
  tamam "deploy/Caddyfile olusturuldu ($DOMAIN)"
  if command -v docker >/dev/null 2>&1; then
    ( cd "$KOK/deploy" && docker compose up -d caddy ) >/dev/null 2>&1 \
      && tamam "Caddy calisiyor (HTTPS)" \
      || uyar "Caddy baslatilamadi"
  fi
fi

# ============================================================================
adim "5/8 Uygulama bagimliliklari"
# ============================================================================
( cd "$KOK/server" && npm install --omit=dev --no-audit --no-fund ) >/dev/null 2>&1 \
  && tamam "npm bagimliliklari kuruldu" \
  || { hata "npm install basarisiz"; exit 1; }

mkdir -p "$KOK/data"
if [ "$HEDEF_KULLANICI" != "root" ]; then
  chown -R "$HEDEF_KULLANICI":"$HEDEF_KULLANICI" "$KOK/data" "$KOK/deploy" "$KOK/server/node_modules" 2>/dev/null || true
fi

# ============================================================================
adim "6/8 systemd servisi"
# ============================================================================
sed -e "s|{KULLANICI}|${HEDEF_KULLANICI}|g" -e "s|{KOK}|${KOK}|g" \
    "$KOK/deploy/sohbet.service.template" > "/etc/systemd/system/${SERVIS_ADI}.service"
systemctl daemon-reload
systemctl enable "$SERVIS_ADI" >/dev/null 2>&1 || true
systemctl restart "$SERVIS_ADI"
sleep 2
if systemctl is-active --quiet "$SERVIS_ADI"; then
  tamam "${SERVIS_ADI} servisi calisiyor"
else
  hata "${SERVIS_ADI} servisi baslamadi. Gunluk: journalctl -u ${SERVIS_ADI} -n 30"
  exit 1
fi

# ============================================================================
adim "7/8 Guvenlik duvari (opsiyonel)"
# ============================================================================
if [ "$ATLA_UFW" = "1" ]; then
  bilgi "ATLA_UFW=1 verildi; guvenlik duvari adimi atlandi"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
  ufw allow "$LIVEKIT_TCP_PORT"/tcp >/dev/null 2>&1 || true
  ufw allow "$LIVEKIT_UDP_PORT"/udp >/dev/null 2>&1 || true
  if [ -n "$DOMAIN" ]; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
  fi
  tamam "ufw kurallari eklendi"
else
  bilgi "ufw aktif degil; guvenlik duvari adimini kendiniz yapin (bkz. KURULUM.md)"
fi

# ============================================================================
adim "8/8 Saglik kontrolu"
# ============================================================================
if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  tamam "Uygulama yanit veriyor: http://127.0.0.1:${PORT}/healthz"
else
  uyar "Saglik kontrolu basarisiz oldu; journalctl -u ${SERVIS_ADI} -n 30 ile bakin"
fi

IP_ADRES="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo -e "${G}${B}Kurulum tamam!${N}"
echo -e "  Yerel adres : http://127.0.0.1:${PORT}"
if [ -n "$DOMAIN" ]; then
  echo -e "  Dis adres   : https://${DOMAIN}"
else
  echo -e "  Ag adresi   : http://${IP_ADRES:-<sunucu-ip>}:${PORT}"
fi
echo -e "  Giris       : kullanici adi ${B}${ADMIN_USERNAME}${N}, sifre ${B}${ADMIN_PASSWORD}${N}"
echo -e "  ${Y}Ilk giriisten sonra sifreyi degistirin!${N}"
echo
echo -e "  Sonraki adimlar: KURULUM.md > 'Kurulum sonrasi'"
echo -e "  Gunluk takip   : journalctl -u ${SERVIS_ADI} -f"
