#!/usr/bin/env bash
# Ev agi (LAN) istemcileri icin sesli gorusme duzeltmesi
#
# SORUN: Router'da NAT dongusu (hairpin) yok. LiveKit "use_external_ip: true" ile
# yerel LAN adayini genel IP ile DEGISTIRIR (eklemez). Ev WiFi'sindeki cihazlar
# 95.70.160.2'ye ulasamaz -> sesli kanal kurulmaz. Metin sohbeti calisir cunku
# o 443/TCP uzerinden Caddy'ye gider.
#
# COZUM: livekit-server v1.13.0 ile gelen iki ayar:
#   advertise_internal_ip: true        -> LAN adayini KORU, genel IP'yi EKLE
#   skip_external_ip_validation: true  -> hairpin olmadigi icin self-ping
#                                         dogrulamasini atla (yoksa LAN adayi
#                                         yine tek genel IP'ye yazilir)
# Bu iki ayar v1.8.x'te YOKTUR. Bu yuzden imaj v1.13.6'ya yukseltilir.
#
# GUVENLIK: Yapilandirma reddedilirse imaj ve ayar otomatik olarak eski haline
# dondurulur; sunucu asla calismaz halde birakilmaz.
set -uo pipefail

DEPLOY=/home/psiko/sohbet/deploy
TARGET_IMAGE="livekit/livekit-server:v1.13.6"
FALLBACK_IMAGE="livekit/livekit-server:v1.8"
APP_PORT=3300

cd "$DEPLOY"
set -a; . ./.env; set +a

ok()  { printf '    \033[1;32mOK\033[0m  %s\n' "$1"; }
bad() { printf '    \033[1;31mHATA\033[0m %s\n' "$1"; }
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

log "0) Mevcut durum yedekleniyor"
STAMP=$(date +%s)
sudo cp livekit.yaml "livekit.yaml.bak-$STAMP"
cp docker-compose.yml "docker-compose.yml.bak-$STAMP"
ok "livekit.yaml.bak-$STAMP + docker-compose.yml.bak-$STAMP"
echo "    su anki imaj: $(grep -oE 'livekit/livekit-server:[^ ]+' docker-compose.yml | head -1)"

log "1) Imaj guncelleniyor: $TARGET_IMAGE"
sed -i "s|image: livekit/livekit-server:.*|image: $TARGET_IMAGE|" docker-compose.yml
grep -n 'image: livekit' docker-compose.yml | sed 's/^/    /'
echo "    imaj cekiliyor (ilk seferde 1-2 dakika surebilir)..."
sudo docker pull "$TARGET_IMAGE" 2>&1 | tail -2 | sed 's/^/    /'

log "2) livekit.yaml sablondan yeniden uretiliyor"
echo "    sablondaki ayarlar:"
grep -nE 'advertise_internal_ip|skip_external_ip_validation|use_external_ip' livekit.yaml.template | sed 's/^/      /'
sed -e "s|__API_KEY__|$LIVEKIT_API_KEY|g" \
    -e "s|__API_SECRET__|$LIVEKIT_API_SECRET|g" \
    -e "s|__APP_PORT__|$APP_PORT|g" \
    livekit.yaml.template > /tmp/lk.new && sudo cp /tmp/lk.new livekit.yaml
sudo chown root:root livekit.yaml 2>/dev/null || true
sudo chmod 600 livekit.yaml
rm -f /tmp/lk.new
ok "livekit.yaml uretildi (keys + webhook.api_key senkron, chmod 600)"

log "3) Konteyner yeniden olusturuluyor"
sudo docker compose up -d --force-recreate livekit 2>&1 | tail -3 | sed 's/^/    /'
sleep 12

log "4) Yapilandirma kabul edildi mi"
CFGERR=$(sudo docker compose logs livekit --tail 50 2>&1 | grep -E 'could not parse config|not found in type|unmarshal errors' | head -4)
if [ -n "$CFGERR" ]; then
  bad "YAPILANDIRMA REDDEDILDI"
  echo "$CFGERR" | sed 's/^/      /'
  log "4b) GERI ALINIYOR -> $FALLBACK_IMAGE"
  sed -i "s|image: livekit/livekit-server:.*|image: $FALLBACK_IMAGE|" docker-compose.yml
  sudo cp "livekit.yaml.bak-$STAMP" livekit.yaml
  sudo docker compose up -d --force-recreate livekit 2>&1 | tail -3 | sed 's/^/    /'
  sleep 10
  sudo docker compose ps --format '    {{.Name}} {{.Status}}' livekit
  echo
  bad "Duzeltme UYGULANAMADI. Eski (calisan) surume donuldu."
  exit 1
fi
ok "parse hatasi yok — ayarlar kabul edildi"
sudo docker compose ps --format '    {{.Name}} {{.Status}}' livekit

log "5) Duyurulan ICE adaylari (asil kanit)"
sudo docker compose logs livekit --tail 80 2>&1 \
  | grep -E 'using external IPs|no external IPs found|advertiseInternalIP' | tail -3 | sed 's/^/    /'
echo "    BEKLENEN: 'using external IPs' + 'advertiseInternalIP: true'"
echo "    ve IP listesinde HEM 192.168.1.11 HEM 95.70.160.2 olmali"
echo "    KOTU SONUC: 'no external IPs found, using node IP' -> sadece genel IP duyuruluyor"

log "6) Saglik kontrolu"
echo -n "    livekit (127.0.0.1:7880): "; curl -s --max-time 5 http://127.0.0.1:7880/ ; echo
echo -n "    uygulama (127.0.0.1:$APP_PORT): "; curl -s --max-time 5 "http://127.0.0.1:$APP_PORT/healthz" ; echo

log "7) Ozet"
sudo docker compose logs livekit --tail 200 2>&1 | grep -oE '"version": "[^"]+"' | tail -1 | sed 's/^/    calisan surum /'
echo "    Sonraki adim: ayni WiFi'deki PC'de Sohbet kisayolunu ac ve bir sesli kanala gir."
