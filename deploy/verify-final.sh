#!/usr/bin/env bash
set -uo pipefail
DEPLOY=/home/psiko/sohbet/deploy
cd "$DEPLOY"

echo "=== 1) install.sh SOZDIZIMI ==="
bash -n install.sh && echo "  OK"

echo
echo "=== 2) ANAHTAR BLOGU BENZETIMI (install.sh mantigi) ==="
if [ -f "$DEPLOY/.env" ]; then
  set -a; . "$DEPLOY/.env"; set +a
  API_KEY="$LIVEKIT_API_KEY"; API_SECRET="$LIVEKIT_API_SECRET"
  echo "  .env'den anahtarlar okundu (degerler gizli)"
else
  echo "  .env yok"; exit 1
fi
sed -e "s|__API_KEY__|$API_KEY|g" \
    -e "s|__API_SECRET__|$API_SECRET|g" \
    -e "s|__APP_PORT__|3300|g" \
    livekit.yaml.template > /tmp/lk.sim

K1=$(grep -m1 -E '^  LK[0-9a-f]+:' /tmp/lk.sim | cut -d: -f1 | tr -d ' ')
K2=$(grep -m1 -E '^\s+api_key:' /tmp/lk.sim | cut -d: -f2 | tr -d ' ')
echo "  keys ile webhook.api_key ayni: $([ "$K1" = "$K2" ] && echo EVET || echo HAYIR)"
echo "  sablon yer tutucusu kaldi mi: $(grep -c '__[A-Z_]*__' /tmp/lk.sim) (0 olmali)"
echo "  mevcut canli yapilandirmayla ayni mi: $(diff -q /tmp/lk.sim livekit.yaml >/dev/null 2>&1 && echo EVET || echo 'HAYIR (fark var)')"
rm -f /tmp/lk.sim

echo
echo "=== 3) SERVIS VE KONTEYNER DURUMU ==="
echo -n "  sohbet servisi: "; systemctl is-active sohbet
echo -n "  caddy: "; sudo docker compose ps --format '{{.Status}}' caddy
echo -n "  livekit: "; sudo docker compose ps --format '{{.Status}}' livekit
echo -n "  yerel uygulama: "; curl -s --max-time 5 http://127.0.0.1:3300/healthz
echo
echo -n "  yerel livekit: "; curl -s --max-time 5 http://127.0.0.1:7880/
echo
echo -n "  sertifika gecerlilik: "
echo | openssl s_client -connect 127.0.0.1:443 -servername helelelelehulululu.duckdns.org 2>/dev/null \
  | openssl x509 -noout -subject -dates 2>/dev/null | tr '\n' ' '
echo
echo "=== 4) LIVEKIT GUNLUGUNDE KRITIK HATA ==="
sudo docker compose logs livekit --tail 60 2>&1 | grep -ciE 'api_key is required|panic|fatal' | sed 's/^0$/  hata yok/; s/^[1-9].*/  HATA VAR/'

echo
echo "=== 5) SIZINTI KONTROLU: gunluklerde sir gorunuyor mu ==="
echo "  (LIVEKIT_API_SECRET degeri journalctl'de var mi)"
grep -c "$LIVEKIT_API_SECRET" /dev/null 2>/dev/null
sudo journalctl -u sohbet --no-pager 2>/dev/null | grep -c "$LIVEKIT_API_SECRET" | sed 's/^0$/  0 - sizinti yok/; s/^[1-9].*/  UYARI: sizinti var/'
echo "  (yardimci: dosya izinleri)"
sudo ls -l .env livekit.yaml | awk '{print "  "$1" "$3":"$4" "$9}'
