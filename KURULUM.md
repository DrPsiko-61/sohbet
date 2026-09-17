# Kurulum Rehberi

Bu dosya; kurulumdan **önce** yapılması gerekenleri, kullanılan **portları**, **tek komut kurulumu**, **kurulum sonrası** adımları ve farklı **sunucu/hosting** senaryolarını anlatır.

---

## 1. Kullanılan portlar

| Port | Protokol | Bileşen | Zorunlu mu? | Not |
|---|---|---|---|---|
| `3300` | TCP | Uygulama (Node.js) | Evet | `PORT` ile değiştirilebilir. Caddy/nginx arkasında `127.0.0.1`'e bağlanır |
| `7880` | TCP | LiveKit sinyalleşme | Sesli görüşme için | WebSocket; HTTPS varsa `/livekit` yolundan ters vekil edilir |
| `7881` | TCP | LiveKit medya (TCP) | Sesli görüşme için | UDP engelliyse yedek yol |
| `7882` | UDP | LiveKit medya (asıl yol) | Sesli görüşme için | **Router'da yönlendirilmesi gereken tek medya portu** |
| `80` / `443` | TCP | Caddy (yalnızca `DOMAIN` verilirse) | Alan adı varsa | Otomatik HTTPS (Let's Encrypt) |

> Yerel ağda (LAN) kullanacaksanız yalnızca `3300`, `7882/udp`, `7881/tcp` yeterlidir.

---

## 2. Kurulumdan önce

### 2.1 Donanım / işletim sistemi
- **İşletim sistemi:** Ubuntu 22.04+ veya Debian 12+ (test edilen: Ubuntu 26.04)
- **RAM:** en az 1 GB (LiveKit + Node + SQLite için 512 MB yeterli, müzik botu ffmpeg ile ~200 MB daha kullanır)
- **Disk:** en az 2 GB (uygulama + node_modules + LiveKit imajı)
- **Mimari:** x86_64 veya arm64 (LiveKit imajı ikisini de destekler)

### 2.2 Kurulacak yazılımlar (script otomatik kurar)
Kurulum scripti şunları yoksa kendisi kurar: **Node.js 22+**, **Docker**, **ffmpeg**, **yt-dlp**, **git**, **curl**. Önceden kurulu olanları atlar.

### 2.3 Alan adı (opsiyonel ama önerilir)
- HTTPS ve dış erişim için bir alan adının sunucu IP'sine **A kaydı** olmalı.
- Alan adı yoksa uygulama HTTP üzerinden çalışır ve yalnızca tarayıcı "güvenli olmayan bağlantı" uyarısı verir; sesli görüşme LAN'da çalışır (bkz. 4.3).

### 2.4 Ağ / yönlendirme
- Router'da (ev sunucusu senaryosu) şu yönlendirmeler gerekir:
  - `3300/tcp` (veya 80/443 kullanıyorsanız onlar) → sunucu
  - `7882/udp` → sunucu (**sesli görüşme için şart**)
  - `7881/tcp` → sunucu (yedek)
- VPS/bulut sunucularda güvenlik duvarı (Security Group / firewall) aynı portlara izin vermelidir.

### 2.5 İlk yönetici hesabı
Kurulum; kullanıcı adı **`admin`**, şifre **`admin`** olan tek bir yönetici hesabı oluşturur. İsterseniz şimdiden değiştirin:
```bash
sudo ADMIN_USERNAME=patron ADMIN_PASSWORD='Guclu-Sifre-2026' bash install.sh
```

---

## 3. Tek komut kurulum

```bash
# 1) Projeyi sunucuya al
sudo mkdir -p /opt/sohbet && sudo chown "$USER":"$USER" /opt/sohbet
git clone <REPO-URL> /opt/sohbet
cd /opt/sohbet

# 2) Tek komut: her seyi kurar ve baslatir
sudo bash install.sh
```

Alan adı ile (HTTPS + LiveKit aynı alan adı üzerinden):
```bash
sudo DOMAIN=sohbet.ornek.com bash install.sh
```

Sadece uygulama (LiveKit'i kendiniz kurduysanız):
```bash
sudo LIVEKIT_KUR=0 bash install.sh
```

Kurulum bittiğinde çıktının sonunda adres ve giriş bilgisi yazdırılır.

---

## 4. Kurulum sonrası

### 4.1 İlk kontroller
```bash
systemctl is-active sohbet                    # active olmali
curl -s http://127.0.0.1:3300/healthz         # "ok" donmeli
journalctl -u sohbet -n 30 --no-pager         # hata var mi
cd /opt/sohbet/deploy && docker compose ps    # livekit/caddy "Up" olmali
```

### 4.2 Zorunlu adımlar
1. Tarayıcıdan girin: `https://<alan-adiniz>` (ya da `http://<sunucu-ip>:3300`).
2. **`admin` / `admin`** ile giriş yapın.
3. **Şifreyi hemen değiştirin** (sağ üstteki kullanıcı menüsü → profil/hesap).
4. **Davet kodu** `deploy/.env` içinde üretilmişti (`INVITE_CODE=...`). Yeni üye kaydı bu kodla yapılır; kod yalnızca yöneticilere görünür. Öğrenmek için:
   ```bash
   grep INVITE_CODE /opt/sohbet/deploy/.env
   ```
5. **Ses testi:** bir sesli kanala girin, ikinci bir cihazla (telefon) aynı kanala katılın. Karşılıklı ses gelmiyorsa 6.2'ye bakın.

### 4.3 Alan adı olmadan kullanım (LAN)
- `LIVEKIT_PUBLIC_URL` otomatik olarak `ws://<sunucu-ip>:7880` yazılır ve istemciler sesli kanala doğrudan bağlanır.
- Tarayıcı HTTP sayfada mikrofon izni verir, ancak **mikrofon yalnızca `https://` veya `localhost` sayfalarda çalışır.** LAN'da başka cihazdan HTTP ile girildiğinde mikrofon/kamera izni verilmez.
- Çözüm: alan adı + HTTPS (önerilen) **veya** cihazda `localhost` tünellemesi. Bu nedenle gerçek kullanım için 2.3'teki alan adını kurmanız önerilir.

### 4.4 Müzik botu
Bot, ilk çalıştırmada kendini kurar:
- `Müzik Botu` adında bir kullanıcı ve `Bot odası` adında sesli kanal oluşturur.
- Herhangi bir metin kanalına komut yazın:
  - `!çal <şarkı adı veya link>` — YouTube / YouTube Music / Spotify linki
  - `!duraklat`, `!devam`, `!durdur`, `!dc`, `!yardım`
- Güncelleme (YouTube değişikliklerinde): `sudo yt-dlp -U`

### 4.5 Yedekleme
Tüm veri `data/` klasöründedir (SQLite + yüklenen dosyalar):
```bash
tar czf sohbet-yedek-$(date +%F).tgz -C /opt/sohbet data deploy/.env
```
Geri yükleme: arşivi açıp servisi yeniden başlatın (`systemctl restart sohbet`).

### 4.6 Güncelleme
```bash
cd /opt/sohbet
sudo git pull
sudo bash install.sh          # bagimliliklari tazeler, servisi yeniden baslatir
```

---

## 5. Sunucu / hosting senaryoları

### 5.1 Kiralık VPS (Ubuntu 22.04/24.04) — önerilen
DigitalOcean, Hetzner, Contabo, Oracle Cloud, AWS Lightsail, Google Compute Engine vb.

1. Sunucuyu Ubuntu imajıyla oluşturun; root veya sudo yetkili kullanıcı edinin.
2. Güvenlik duvarında (Security Group / ufw) şu portları açın: `22`, `80`, `443`, `7882/udp`, `7881/tcp`.
3. Alan adının A kaydını sunucu IP'sine yönlendirin.
4. Kurulumu yapın:
   ```bash
   sudo apt-get update && sudo apt-get install -y git
   sudo git clone <REPO-URL> /opt/sohbet
   cd /opt/sohbet && sudo DOMAIN=sohbet.ornek.com bash install.sh
   ```
   > Bulut sağlayıcının güvenlik duvarı ayrıysa (AWS/Azure/GCP), `7882/udp`'yi orada da açmayı unutmayın; yoksa bağlantı kurulur ama **ses gelmez**.

### 5.2 Ev sunucusu / Raspberry Pi (LAN + port yönlendirme)
1. Sabit iç IP verin (router DHCP rezervasyonu).
2. Router'da yönlendirme: `7882/udp` → sunucu, `7881/tcp` → sunucu. HTTP kullanacaksanız `3300/tcp` (veya 80/443).
3. Kurulum: `sudo bash install.sh` (alan adı yoksa HTTP).
4. Dış erişim isterseniz alan adı + `DOMAIN=` ile yeniden çalıştırın; Caddy Let's Encrypt sertifikasını otomatik alır (`80/443` yönlendirmesi şart).
5. **NAT döngüsü (hairpin):** Router NAT döngüsünü desteklemiyorsa ev içindeki cihazlar dış alan adına bağlanamaz. LiveKit yapılandırmasında `advertise_internal_ip: true` olduğu için yerel istemciler LAN adresini kullanır; bu ayar varsayılan gelir, değiştirmeyin.

### 5.3 Docker ile kurulum (uygulama dahil)
LiveKit zaten konteynerde çalışır. Uygulamayı da konteynerlemek isterseniz Node 22 imajıyla basit bir Dockerfile:
```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y ffmpeg curl && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp
WORKDIR /app
COPY server/package*.json server/
RUN npm ci --omit=dev --prefix server
COPY server/src server/src
COPY web web
ENV PORT=3300 HOST=0.0.0.0 DATA_DIR=/data WEB_DIR=/app/web
VOLUME /data
EXPOSE 3300
CMD ["node", "server/src/index.js"]
```
Çalıştırma:
```bash
docker build -t sohbet .
docker run -d --name sohbet --restart always --network host \
  -v /opt/sohbet/data:/data --env-file deploy/.env sohbet
```
> `--network host` LiveKit'e `127.0.0.1:7880` üzerinden erişmek için gereklidir.

### 5.4 Nginx veya başka ters vekil arkasında
`deploy/.env` içinde `HOST=127.0.0.1` yapın ve gelen isteği 3300'e aktarın:
```nginx
server {
    listen 443 ssl;
    server_name sohbet.ornek.com;
    # ssl_certificate ...;

    location /livekit {                 # LiveKit WebSocket
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # sohbet WebSocket'i icin
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 10m;
    }
}
```
`LIVEKIT_PUBLIC_URL` değerini `wss://sohbet.ornek.com/livekit` yapın ve servisi yeniden başlatın.

### 5.5 Paylaşımlı hosting / Plesk / cPanel
Bu uygulama **Node.js süreci + WebSocket + UDP medya** gerektirir; klasik paylaşımlı PHP hosting'lerde çalışmaz. Uygun seçenekler:
- Node.js destekli VPS (5.1)
- Plesk'te "Node.js" uygulaması olarak: uygulama kökü `server`, başlangıç dosyası `src/index.js`, çevre değişkenleri `deploy/.env`'den verilir. UDP/medya portları için yine sunucu güvenlik duvarı ayarı gerekir.
- Railway / Render / Fly.io gibi PaaS'lar: WebSocket destekler ama **UDP medya portları genelde açılamaz**; LiveKit'i ayrı bir VPS'te çalıştırıp `LIVEKIT_HTTP_URL`/`LIVEKIT_PUBLIC_URL` ile bağlamanız gerekir.

---

## 6. Sorun giderme

### 6.1 Genel
| Belirti | Olası neden / çözüm |
|---|---|
| Servis başlamıyor | `journalctl -u sohbet -n 50` — genelde `deploy/.env` eksik veya Node sürümü eski |
| Sayfa açılıyor ama `401` | Oturum çerezi; HTTPS'te `COOKIE_SECURE=true`, HTTP'de `false` olmalı |
| Yüklenen dosya hatası | `MAX_UPLOAD_BYTES` ve ters vekildeki `client_max_body_size` |
| Müzik botu cevap vermiyor | `pgrep -a ffmpeg`, `journalctl -u sohbet | grep muzik-bot`; `yt-dlp -U` ile güncelleyin |

### 6.2 Ses sorunları (en sık)
1. **Bağlanıyor ama ses gelmiyor:** Medya yolu kapalı. `7882/udp` hem router'da hem bulut güvenlik duvarında açık olmalı. Test: `sudo ss -ulnp | grep 7882`.
2. **Yalnızca dışarıdan bağlananlar ses alamıyor:** `use_external_ip: true` ve `7882/udp` yönlendirmesi gerekir.
3. **Yalnızca ev içinden bağlananlar ses alamıyor:** `advertise_internal_ip: true` olmalı (varsayılan).
4. **Mikrofon izni istenmiyor:** Sayfa HTTPS değil. `localhost` dışında HTTP'de tarayıcı mikrofon vermez (bkz. 4.3).
5. **LiveKit log:** `cd /opt/sohbet/deploy && docker compose logs livekit --tail 100`

### 6.3 Yararlı komutlar
```bash
journalctl -u sohbet -f                     # canli uygulama gunlugu
systemctl restart sohbet                    # yeniden baslat
cd /opt/sohbet/deploy && docker compose logs -f livekit
curl -s http://127.0.0.1:7880               # LiveKit ayakta mi ("OK" doner)
```

---

## 7. Ortam değişkenleri (deploy/.env)

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `PORT` | Uygulama portu | `3300` |
| `HOST` | Dinlenecek adres (`127.0.0.1` = yalnızca ters vekil arkası) | `0.0.0.0` |
| `DATA_DIR` | Veritabanı + dosyalar | `<kok>/data` |
| `WEB_DIR` | Statik dosyalar | `<kok>/web` |
| `COOKIE_SECURE` | Oturum çerezi yalnızca HTTPS'te | HTTPS varsa `true` |
| `INVITE_CODE` | Kayıt için davet kodu (boş = kayıt kapalı) | rastgele üretilir |
| `MAX_UPLOAD_BYTES` | En büyük dosya boyutu | `8388608` (8 MB) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Yalnızca ilk kurulumda oluşturulur | `admin` / `admin` |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit anahtarları | üretilir |
| `LIVEKIT_HTTP_URL` | Sunucudan LiveKit'e erişim | `http://127.0.0.1:7880` |
| `LIVEKIT_PUBLIC_URL` | Tarayıcıya verilen adres (`wss://...` / `ws://...`) | üretilir |
| `LIVEKIT_WS_URL` | Bot gibi sunucu tarafı WS adresi | `ws://127.0.0.1:7880` |
