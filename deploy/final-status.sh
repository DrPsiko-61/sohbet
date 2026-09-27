#!/usr/bin/env bash
set -uo pipefail
cd /home/psiko/sohbet

echo "=== TEMIZLIK ==="
rm -f /tmp/whook_listener.cjs /tmp/whook.log /tmp/join*.log /tmp/lk.sim /tmp/lk.new 2>/dev/null
ls /tmp/whook* /tmp/join* /tmp/lk.* 2>/dev/null && echo "  artik kaldi" || echo "  /tmp temiz"
chmod +x deploy/*.sh
echo "  betikler calistirilabilir"

echo
echo "=== DOSYA DUZENI ==="
find . -type f | sort | sed 's/^/  /'

echo
echo "=== SERVIS DURUMU ==="
echo -n "  sohbet servisi    : "; systemctl is-active sohbet
echo -n "  acilista otomatik : "; systemctl is-enabled sohbet
echo -n "  caddy konteyner   : "; sudo docker compose -f deploy/docker-compose.yml ps --format '{{.Status}}' caddy
echo -n "  livekit konteyner : "; sudo docker compose -f deploy/docker-compose.yml ps --format '{{.Status}}' livekit

echo
echo "=== SAGLIK ==="
echo -n "  uygulama (3300) : "; curl -s --max-time 5 http://127.0.0.1:3300/healthz
echo
echo -n "  livekit (7880)  : "; curl -s --max-time 5 http://127.0.0.1:7880/
echo

echo
echo "=== VERI DURUMU ==="
echo -n "  kullanici sayisi : "
node --no-warnings -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/home/psiko/sohbet/data/chat.db');console.log(d.prepare('SELECT COUNT(*) n FROM users').get().n + ' (0 olmali - ilk kayit seni kurucu yapar)')" 2>/dev/null
echo "  veritabani dosyasi:"
sudo ls -la data/ | sed 's/^/    /'

echo
echo "=== GIZLI DOSYALAR ==="
sudo ls -l deploy/.env deploy/livekit.yaml | awk '{print "  "$1" "$3":"$4" "$9}'
echo "  davet kodu icin: grep INVITE_CODE ~/sohbet/deploy/.env"

echo
echo "=== GUVENLIK DUVARI ==="
sudo ufw status | grep -E '^(443|7881|7882|3478|35000|22)' | sed 's/^/  /'

echo
echo "=== GUNLUKLERDE SIR SIZINTISI KONTROLU ==="
set -a; . deploy/.env; set +a
echo -n "  journalctl'de api secret        : "
sudo journalctl -u sohbet --no-pager 2>/dev/null | grep -c "$LIVEKIT_API_SECRET" | sed 's/^0$/yok/; s/^[1-9].*/VAR/'
echo -n "  /etc/hosts gecici kayit kaldi mi: "
grep -c 'abacus-test\|# test' /etc/hosts 2>/dev/null || echo 0
