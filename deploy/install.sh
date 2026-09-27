#!/usr/bin/env bash
# Sohbet platformu kurulum betigi (Ubuntu + CasaOS uzerinde calisir)
# Kullanim: bash install.sh <app-domain> <live-domain>
set -euo pipefail

APP_DIR="/home/psiko/sohbet"
SERVER_DIR="$APP_DIR/server"
WEB_DIR="$APP_DIR/web"
DEPLOY_DIR="$APP_DIR/deploy"
DATA_DIR="$APP_DIR/data"
APP_PORT=3300

APP_DOMAIN="${1:-}"
LIVE_DOMAIN="${2:-}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mHATA: %s\033[0m\n' "$1" >&2; exit 1; }

[ -n "$APP_DOMAIN" ]  || die "kullanim: bash install.sh <app-domain> <live-domain>"
[ -n "$LIVE_DOMAIN" ] || die "kullanim: bash install.sh <app-domain> <live-domain>"

log "1/9 Yetki kontrolu"
sudo -n true 2>/dev/null || die "parolasiz sudo yok. README'deki sudoers adimini yap."
ok "parolasiz sudo calisiyor"

log "2/9 Dosya duzeni"
mkdir -p "$DATA_DIR" "$DEPLOY_DIR/caddy_data" "$DEPLOY_DIR/caddy_config"
[ -f "$SERVER_DIR/src/index.js" ] || die "uygulama dosyalari eksik: $SERVER_DIR/src/index.js yok"
[ -f "$WEB_DIR/index.html" ]      || die "arayuz dosyalari eksik: $WEB_DIR/index.html yok"
ok "dizinler hazir"

log "3/9 Gizli anahtarlar"
if [ -f "$DEPLOY_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DEPLOY_DIR/.env"
  set +a
  API_KEY="$LIVEKIT_API_KEY"
  API_SECRET="$LIVEKIT_API_SECRET"
  ok "mevcut anahtarlar .env dosyasindan okundu"
else
  API_KEY="LK$(openssl rand -hex 12)"
  API_SECRET="$(openssl rand -base64 36 | tr -d '\n=+/' | cut -c1-40)"
  INVITE_CODE="$(openssl rand -hex 4)"
  PUBLIC_IP="$(curl -s --max-time 10 https://api.ipify.org || echo '')"

  cat > "$DEPLOY_DIR/.env" <<ENVEOF
PORT=$APP_PORT
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
WEB_DIR=$WEB_DIR
COOKIE_SECURE=true
INVITE_CODE=$INVITE_CODE
LIVEKIT_API_KEY=$API_KEY
LIVEKIT_API_SECRET=$API_SECRET
LIVEKIT_HTTP_URL=http://127.0.0.1:7880
LIVEKIT_PUBLIC_URL=wss://$LIVE_DOMAIN
MAX_UPLOAD_BYTES=8388608
ENVEOF
  chmod 600 "$DEPLOY_DIR/.env"
  ok "anahtarlar uretildi (icerik gizli tutuldu)"
  echo "    Davet kodu dosyada: $DEPLOY_DIR/.env  ->  INVITE_CODE satiri"
  [ -n "$PUBLIC_IP" ] && echo "    Sunucunun genel IP'si: $PUBLIC_IP"
fi

# LiveKit yapilandirmasi HER ZAMAN sablondan yeniden uretilir: keys bolumu ile
# webhook.api_key ayni degerden gelmezse LiveKit "api_key is required to use
# webhooks" hatasiyla surekli yeniden baslar.
sed -e "s|__API_KEY__|$API_KEY|g" \
    -e "s|__API_SECRET__|$API_SECRET|g" \
    -e "s|__APP_PORT__|$APP_PORT|g" \
    "$DEPLOY_DIR/livekit.yaml.template" > "$DEPLOY_DIR/livekit.yaml"
chmod 600 "$DEPLOY_DIR/livekit.yaml"
ok "livekit.yaml sablondan uretildi (keys + webhook.api_key senkron)"

log "4/9 Caddyfile olusturuluyor"
sed -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
    -e "s|__LIVE_DOMAIN__|$LIVE_DOMAIN|g" \
    -e "s|__APP_PORT__|$APP_PORT|g" \
    -e "s|__EMAIL__|admin@$APP_DOMAIN|g" \
    "$DEPLOY_DIR/Caddyfile.template" > "$DEPLOY_DIR/Caddyfile"
ok "$APP_DOMAIN -> uygulama, $LIVE_DOMAIN -> LiveKit"

log "5/9 Guvenlik duvari (UFW) kurallari"
for rule in "443/tcp" "7881/tcp" "7882/udp" "3478/udp" "3478/tcp" "35000:35020/udp" "22/tcp"; do
  sudo ufw allow "$rule" >/dev/null 2>&1 && ok "$rule acildi" || warn "$rule eklenemedi"
done
sudo ufw status verbose | head -1

log "6/9 Docker servisleri baslatiliyor"
cd "$DEPLOY_DIR"
sudo docker compose pull -q 2>&1 | tail -3 || warn "imaj cekme uyarisi"
sudo docker compose up -d 2>&1 | tail -6
ok "livekit + caddy baslatildi"

log "7/9 Uygulama bagimliliklari"
cd "$SERVER_DIR"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
ok "npm paketleri kuruldu"

log "8/9 systemd servisi"
NODE_BIN="$(command -v node)"
sed -e "s|__NODE_BIN__|$NODE_BIN|g" "$DEPLOY_DIR/sohbet.service.template" > "$DEPLOY_DIR/sohbet.service"
sudo cp "$DEPLOY_DIR/sohbet.service" /etc/systemd/system/sohbet.service
sudo systemctl daemon-reload
sudo systemctl enable sohbet >/dev/null 2>&1
sudo systemctl restart sohbet
sleep 3
systemctl is-active --quiet sohbet && ok "sohbet servisi calisiyor" || { warn "servis baslamadi, gunluk:"; sudo journalctl -u sohbet -n 25 --no-pager; }

log "9/9 Saglik kontrolleri"
sleep 4
cd "$DEPLOY_DIR"
echo -n "    yerel uygulama (127.0.0.1:$APP_PORT): "
curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 "http://127.0.0.1:$APP_PORT/healthz" || echo "yanit yok"
echo -n "    livekit (127.0.0.1:7880): "
curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 "http://127.0.0.1:7880/" || echo "yanit yok"

echo
echo "    Konteynerler:"
sudo docker compose ps --format '      {{.Name}} | {{.Status}}' 2>&1

echo
echo "    Sertifika alinmasi 30 saniye kadar sürebilir. Caddy gunlugu:"
sudo docker compose logs caddy --tail 15 2>&1 | sed 's/^/      /'

echo
printf '\033[1;32mKurulum tamam.\033[0m Simdi tarayicidan: https://%s\n' "$APP_DOMAIN"
echo "Davet kodunu ogrenmek icin (sadece sen calistir): grep INVITE_CODE $DEPLOY_DIR/.env"
