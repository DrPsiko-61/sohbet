# Sohbet — kendi Discord alternatifin

7 kişilik özel kullanım için yazılmış, **düşük bant genişliğine göre ayarlanmış** grup sohbet platformu.
Ev sunucunda (Ubuntu + CasaOS) çalışıyor, tarayıcıdan yönetiliyor, telefonla tam uyumlu.

**Canlı adres:** https://helelelelehulululu.duckdns.org
**Ses/video sunucusu:** wss://helelelelehulululu-live.duckdns.org
**Sunucu genel IP:** 95.70.160.2 · **yerel IP:** 192.168.1.11

---

## 1. Mevcut durum (kurulu ve çalışıyor)

| Bileşen | Durum | Not |
|---|---|---|
| Uygulama (Node) | `systemctl status sohbet` → active, enabled | 127.0.0.1:3300, otomatik başlar |
| Caddy (TLS + ters vekil) | konteyner `sohbet-caddy` | 443, otomatik sertifika |
| LiveKit (SFU) | konteyner `sohbet-livekit` | 7880 sinyal, 7881 TCP, 7882 UDP, TURN 3478 |
| Sertifika | Let's Encrypt | 12 Aralık 2026'ya kadar geçerli, otomatik yenilenir |
| Veritabanı | SQLite (`~/sohbet/data/chat.db`) | **şu an boş — 0 kullanıcı** |
| Güvenlik duvarı | UFW | 443, 7881/tcp, 7882/udp, 3478, 35000-35020 açık |

Port **80'e dokunulmadı** — CasaOS orada çalışıyor. Sertifika, port 80'e ihtiyaç duymayan
TLS-ALPN-01 yöntemiyle 443 üzerinden alınıyor. Jellyfin, Samba, rclone, Redis, pm2 ve
CasaOS servislerinin hiçbirine dokunulmadı.

---

## 2. İlk kullanım — hemen yapılacaklar

### 2.1 İlk hesabı aç (kurucu olur)

1. Telefonunda veya bilgisayarında **https://helelelelehulululu.duckdns.org** adresini aç
2. **"Hesabın yok mu? Kayıt ol"** → kullanıcı adı, görünen ad, parola (en az 8 karakter)
3. **İlk kayıt olan kişi otomatik olarak "kurucu" olur** ve tüm yetkileri alır

> Bu adımı sen yap. Test verileri silindiği için ilk kayıt olan sen olacaksın.

### 2.2 Davet kodunu öğren

Diğerlerinin kendilerinin kaydolmasına izin vermek istersen bu kodu paylaş:

```bash
grep INVITE_CODE ~/sohbet/deploy/.env
```

**Daha güvenli yol:** Kodu hiç paylaşma. Yönetim panelinden onlar için hesap aç:
Yönetim paneli → Kullanıcılar → kullanıcı adı / görünen ad / parola / rol → "Kullanıcı oluştur".
Sonra sadece kullanıcı adı ve parolayı onlara ver.

### 2.3 Telefona uygulama olarak kur (PWA)

- **Android (Chrome):** Menü → "Uygulamayı yükle" / "Ana ekrana ekle"
- **iOS (Safari):** Paylaş → "Ana Ekrana Ekle"

Kurulunca tam ekran açılır, adres çubuğu görünmez.

---

## 3. Bant genişliği ayarları (projenin asıl amacı)

| Katman | Ayar | Fayda |
|---|---|---|
| Ses | Opus **mono 16 kbps** + DTX + RED | Discord varsayılanının ~3 katı verimli |
| Kamera | 180p/360p **simulcast**, VP8 | Ağ kötüleşince donma yerine bulanıklık |
| Ekran | **5 fps**, en fazla 700 kbps, metin modu | Hareketsiz ekranda bant harcamaz |
| LiveKit | `adaptiveStream` + `dynacast` | İzlenmeyen akış hiç gönderilmez |
| Metin | WebSocket sıkıştırma, 50'lik sayfalama | Tekrar indirme yok |
| Arayüz | 220 mesaj sınırı, `loading="lazy"` | DOM şişmez, kaydırma akıcı |
| LiveKit SDK | Yalnız sese ilk girişte indirilir (580 KB) | Sadece yazışan kişi hiç indirmez |
| Servis çalışanı | Varlık önbelleği | Tekrar ziyaretlerde indirme ~0 |

**Beklenen tüketim (7 kişilik sesli grup):** kişi başı indirme ~60-90 kbps, yükleme ~30 kbps.
Saatte yaklaşık **20-35 MB / kişi**.

### Neden SFU (mesh değil)

Peer-to-peer mesh'te 7 kişide her istemci 6 ayrı akış gönderir. Kötü internetli biri için:
- Mesh: 6 × 30 kbps = **~180 kbps yükleme** (video açılırsa 2,4 Mbps — çoğu hatta imkânsız)
- SFU: 1 × 30 kbps = **~30 kbps yükleme**

SFU, kötü hattın yüklemesini **6 kat** düşürür, cihazdaki encoder yükünü 6'dan 1'e indirir.

---

## 4. Bilinen sınırlar

- **Mobil tarayıcılarda ekran paylaşımı çalışmaz.** Android Chrome ve iOS Safari
  `getDisplayMedia` desteklemiyor — tarayıcı kısıtı, kodla çözülemez. Kamera ve mikrofon
  mobilde sorunsuz. Ekran paylaşımı masaüstünde kullanılır.
- **Telefon ekranı kapalıyken ses devam etmez**; tarayıcılar arka plan sekmesini kısıtlar.
- **"Donma 0" fiziksel olarak mümkün değil.** Hedef: donma yerine kalite düşüşü.
  Paket kaybı ve baz istasyonu değişimi bizim kontrolümüzde değil.
- NAT döngüsü (hairpin) yok: ev ağından `helelelelehulululu.duckdns.org` adresi çalışmayabilir.
  Ev içinden bağlanmak için https://192.168.1.11 kullanamazsın (sertifika alan adına bağlı);
  telefondan mobil veriyle veya dışarıdan test et.

---

## 5. Yönetim paneli

Sol alttaki kaydırıcı simgesi (kurucu/yönetici/moderatör görür). Dört sekme:

- **Kullanıcılar:** açma, silme, rol verme (kurucu/yönetici/moderatör/üye/misafir),
  devre dışı bırakma, atma, şifre sıfırlama
- **Kanallar:** oluşturma, yeniden adlandırma, silme
- **Sunucular:** ad değiştirme, üye ve mesaj sayıları
- **Kayıtlar:** kim ne yaptı (denetim izi)

**Roller:** kurucu > yönetici > moderatör > üye > misafir. Misafir okuyabilir ama yazamaz.

---

## 6. Bakım

```bash
# Durum
sudo systemctl status sohbet
sudo docker compose -f ~/sohbet/deploy/docker-compose.yml ps

# Günlükler
sudo journalctl -u sohbet -f
sudo docker compose -f ~/sohbet/deploy/docker-compose.yml logs -f livekit

# Yeniden başlat
sudo systemctl restart sohbet
sudo docker compose -f ~/sohbet/deploy/docker-compose.yml restart

# Yedekleme (günlük önerilir)
mkdir -p ~/yedek
sqlite3 ~/sohbet/data/chat.db ".backup ~/yedek/chat-$(date +%F).db"
tar -czf ~/yedek/dosyalar-$(date +%F).tgz -C ~/sohbet/data files
```

---

## 7. ÖNEMLİ: LiveKit anahtarlarını değiştirirken

`~/sohbet/deploy/livekit.yaml` içinde anahtar **iki yerde** geçer: `keys:` bölümü ve
`webhook.api_key`. Bunlar birbirinden farklı olursa LiveKit şu hatayla sürekli yeniden başlar
ve **sesli görüşme tamamen çalışmaz**:

```
api_key is required to use webhooks
```

Bu yüzden anahtar değiştirmek gerekirse `livekit.yaml`'ı elle düzenleme — şablondan üret:

```bash
cd ~/sohbet/deploy
set -a; . ./.env; set +a
sed -e "s|__API_KEY__|$LIVEKIT_API_KEY|g" \
    -e "s|__API_SECRET__|$LIVEKIT_API_SECRET|g" \
    -e "s|__APP_PORT__|3300|g" \
    livekit.yaml.template > /tmp/lk.new
sudo cp /tmp/lk.new livekit.yaml && sudo chmod 600 livekit.yaml
sudo docker compose up -d --force-recreate livekit
```

`install.sh` bunu artık otomatik yapıyor (her çalıştırmada yapılandırmayı şablondan üretir),
yani betiği tekrar çalıştırmak güvenli.

---

## 8. Sorun giderme

| Belirti | Sebep / çözüm |
|---|---|
| LiveKit konteyneri sürekli yeniden başlıyor | Anahtar senkron sorunu — bölüm 7'ye bak |
| Sertifika alınmadı | 443 kapalı. `sudo docker compose logs caddy`; router yönlendirmesini kontrol et |
| Sesli kanala girilmiyor | 7881/tcp, 7882/udp, 3478 açık mı: `sudo ufw status` + router |
| Karşı tarafın sesi gelmiyor | Kullanıcı TURN'e düşmüş olabilir; 3478 ve 35000-35020 açık olmalı |
| Kamera açılmıyor | Tarayıcı izni gerekli; HTTPS şart (alan adıyla gir, IP ile değil) |
| Ekran paylaşımı butonu çalışmıyor | Mobil tarayıcıda desteklenmiyor, normal |
| Mesajlar gelmiyor | WebSocket kopmuş; üstteki yeşil nokta bağlantı durumunu gösterir |
| Ev ağından alan adı açılmıyor | NAT döngüsü (hairpin) yok — dışarıdan/mobil veriyle test et |

---

## 9. Dış sitede ortak izleme (PartyCaster partisi)

Film sitelerinde (hdfilmcehennemi, dizilla, pichive ...) **ekran paylaşımı olmadan**
senkron film izleme. Herkes filmi kendi tarayıcısında açar, oynat/duraklat/sarma
İzleme odasındaki "parti" üzerinden yayılır; konuşma yine Sohbet'in sesli odasından
yapılır.

### Nasıl kullanılır

1. Sohbet'te **İzleme** kanalına gir → üstteki **"Dış sitede ortak izleme"** panelinde
   **Parti kur**. Panel bir kod üretir (örn. `AB2C-DE3F`) ve düğmesiyle kopyalanır.
2. Film adresini paneldeki **Film adresi** alanına yapıştırıp **Paylaş** (İzleme
   odasındaki herkes bağlantıyı görür).
3. Herkes filmi kendi tarayıcısında aynı sayfada açar.
4. Tarayıcıdaki **PartyCaster** eklentisinde (film sayfasının sağ üstünde açılan yan
   panel ya da eklenti düğmesi) **Sohbet odası** bölümüne bu kodu girip **Bağlan**.
   Bağlantı bir kez kurulunca kod hatırlanır: yeni bölüm/film sayfası açıldığında
   eklenti kendiliğinden bağlanır.
5. Ses ayarları odadaki herkese yayılır: **Film sesi** (sitedeki video) ve
   **Sohbet sesi** (konuşanlar) ayrı ayrı kısılır/açılır. Sohbet tarafındaki
   kaydırıcılar da eklenti panelindekiler de aynı odayı yönetir.
6. İş bitince panelden **Bitir**: oda kapanır, kod geçersiz olur. Kimse kalmazsa oda
   zaman aşımına uğrar.

### Nasıl çalışır

- Eklenti, odaya `wss://helelelelehulululu.duckdns.org/ws?party=KOD` adresiyle bağlanır;
  kimlik için ayrı oturum gerekmez (misafir rolü).
- WebSocket bağlantısı eklentinin servis çalışanında tutulur: film sitesinin içerik
  güvenliği politikası (CSP) sayfa içinden kurulan bağlantıyı engelleyebiliyor.
- Eklenti videoyu izler: yerel oynat/duraklat/sarma olaylarını odaya bildirir,
  odadan gelen komutları uygular. iframe içindeki oynatıcılar (hdfilmcehennemi)
  postMessage köprüsüyle yönetilir; ses ayarı da frame'e iletilir.
- Sohbet web tarafı aynı odayı `party_attach`, `party_control`, `party_volume`,
  `party_nav` mesajlarıyla kullanır; sunucu tarafı `server/src/party.js`.

> **Not:** Eklenti `D:\workspace\partycaster\chrome` klasöründen yükleniyorsa, bu
> sürümden sonra `chrome://extensions` → **PartyCaster** → **Yenile** demek gerekir
> (sürüm 0.5.0). Firefox kopyası `partycaster\firefox` klasöründe aynı kodla durur.

### Dosyalar

| Dosya | İş |
|---|---|
| `server/src/party.js` | parti durumu: kod üretimi, konum/süre, ses seviyeleri, TTL |
| `server/src/ws.js` | `party_*` mesajları, eklenti misafir oturumu (`?party=KOD`) |
| `server/src/http.js` | `POST/GET /api/watch/party` (kod kur/yenile/durum) |
| `web/app.js`, `web/index.html`, `web/app.css` | İzleme odasındaki parti paneli + ses kaydırıcıları |
| `web/watch.js` | film sesi (`setVolume`) |
| `web/voice.js` | sohbet sesi (`setGlobalVolume`) |
| `partycaster/chrome/background.js` | odaya WebSocket bağlantısı, mesaj köprüsü |
| `partycaster/chrome/content.js` | yan panel, senkron, site/film ses denetimi |
| `partycaster/chrome/popup.*` | kod girip bağlanma arayüzü |

---

## 10. Testler

```bash
cd ~/sohbet/server

# 36 testlik doğrulama (canlı alan adı üzerinden, gerçek TLS ile)
echo "127.0.0.1 helelelelehulululu.duckdns.org helelelelehulululu-live.duckdns.org # test" | sudo tee -a /etc/hosts
BASE=https://helelelelehulululu.duckdns.org node smoke.mjs
sudo sed -i '/# test/d' /etc/hosts
```
Beklenen: `SONUC: 36 gecti, 0 basarisiz`

> `/etc/hosts` eklemesi gerekli çünkü router NAT döngüsünü desteklemiyor; sunucu kendi genel
> IP'sine bağlanamıyor. Bu ekleme trafiği yerel Caddy'ye yönlendirir, sertifika yine gerçek.

`WEBHOOK_DEBUG=true` ortam değişkenini `deploy/.env` dosyasına eklersen, LiveKit'ten gelen
track olayları günlüğe yazılır (ses/kamera durumu teşhisi için):

```bash
sudo journalctl -u sohbet -f | grep -E 'WEBHOOK_DEBUG|VOICE_TRACE'
```

### Parti (dış sitede ortak izleme) testleri

Bu betikler Windows tarafındaki geliştirme makinesinden çalışır; sunucuda geçici oturum
üretmek için `~/sohbet/server/_session_mint.mjs` ve `_party_kapat.mjs` yardımcıları
kullanılır (port 3300'e SSH tüneli açılır — UFW yalnızca 443'e izin veriyor):

```powershell
cd D:\workspace\helelelele

# Sunucu tarafı: parti protokolü uçtan uca (HTTP + WebSocket)
ssh -i $env:USERPROFILE\.ssh\id_ed25519 psiko@192.168.1.11 `
  "cd ~/sohbet/server && node --env-file=../deploy/.env _party_test.mjs"

# Web arayüzü: gerçek Chrome'da parti paneli, kod, ses kaydırıcıları
node pc-app\cdp-parti-test.mjs

# Eklenti: gerçek Chrome'da PartyCaster odaya bağlanıp videoyu senkronluyor mu
node pc-app\cdp-parti-eklenti-test.mjs
```

Beklenen: her betiğin sonunda `TUM ADIMLAR BASARILI`. İkinci ve üçüncü betik, eklentinin
`chrome/` klasörünün bir kopyasını `%TEMP%\pc-parti-eklenti` altına kurar (test için
`127.0.0.1` izni eklenir) ve test film sayfasını `.verif/pc-parti/` altından servis eder.

---

## 11. Dosya düzeni

```
~/sohbet/
├── server/                  # arka uç (Node 22)
│   ├── src/db.js            # SQLite şema ve sorgular
│   ├── src/auth.js          # parola hash'i (scrypt), oturumlar, roller
│   ├── src/http.js          # REST API + dosya servisi + webhook ucu
│   ├── src/ws.js            # WebSocket (canlı mesaj, ses durumu, izleme odası, parti)
│   ├── src/rtc.js           # LiveKit token + webhook normalizasyonu
│   ├── src/party.js         # dış site partisi (kod, konum, ses seviyeleri, TTL)
│   ├── src/watch.js         # izleme odası durumu (sunucudaki video)
│   ├── src/videos.js        # video kütüphanesi (liste, ad güvenliği, disk)
│   ├── src/index.js         # giriş noktası
│   ├── smoke.mjs            # 36 testlik doğrulama betiği
│   └── _party_test.mjs      # parti protokolü testi (geçici yardımcılar: _session_mint, _party_kapat)
├── web/                     # ön yüz (PWA)
│   ├── index.html, app.css, app.js
│   ├── voice.js             # ses/kamera/ekran modülü
│   ├── watch.js             # izleme odası oynatıcısı (film sesi)
│   ├── sw.js                # servis çalışanı (önbellek)
│   └── vendor/              # LiveKit istemcisi (yerel, CDN'e bağımlı değil)
├── pc-app/                  # masaüstü/CDP testleri (cdp-parti-test, cdp-parti-eklenti-test ...)
├── pc-yukleyici/            # bilgisayardan sunucuya video yükleme aracı
├── .verif/pc-parti/         # eklenti testi için yerel film sayfası + sunucu
├── deploy/
│   ├── install.sh           # kurulum/yeniden kurulum (idempotent)
│   ├── verify-final.sh      # sağlık ve senkron kontrolü
│   ├── Caddyfile.template   # TLS + ters vekil
│   ├── livekit.yaml.template
│   ├── livekit.yaml         # üretilmiş (chmod 600) — elle düzenleme
│   ├── sohbet.service.template
│   ├── docker-compose.yml
│   └── .env                 # gizli anahtarlar (chmod 600)
└── data/                    # veritabanı + yüklenen dosyalar
```

---

## 12. Mimari

```
Tarayıcı ──443/HTTPS──> Caddy ──┬──> 127.0.0.1:3300  Node uygulaması (API + WebSocket)
                                └──> 127.0.0.1:7880  LiveKit sinyalleşme
Tarayıcı ──7882/UDP────> LiveKit (medya, doğrudan — 7881/TCP yedek, 3478 TURN)
```

Metin trafiği tamamen 443'ten geçer (kısıtlı ağlarda bile çalışır). Ses/video doğrudan
UDP 7882'yi kullanır; bu engellenirse TCP 7881'e, son çare TURN 3478'e düşer.
