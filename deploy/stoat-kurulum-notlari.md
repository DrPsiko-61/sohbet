# Stoat (eski adiyla Revolt) Kurulum Notlari

Stoat, kendi sohbet sisteminin (helelelelehulululu.duckdns.org) yaninda
`pipiandkaki.duckdns.org` adresinde calisir. Kurulum dizini: `/home/psiko/stoat/`

## Mimari

```
Internet
   |
   v
[sohbet-caddy]  (Docker, host network, port 80+443)
   |  pipiandkaki.duckdns.org -> 127.0.0.1:8880
   v
[stoat-caddy-1]  (Docker, port 8880 -> 80)
   |  /ws  -> events:14703
   |  /api -> api:14702
   |  /    -> web (statik)
   v
[stoat-events-1] [stoat-api-1] [stoat-database-1] [stoat-rabbit-1] [stoat-redis-1] ...
```

- Stoat'in kendi Caddy'si **HTTP** olarak 8880 portunda dinler.
- Ana Caddy (`sohbet-caddy`) TLS sonlandirmasi yapar ve Let's Encrypt
  sertifikasi alir.
- LiveKit RTC: **7891/tcp** + **50200-50300/udp** (router'da yonlendirilmeli).

## Kritik Duzeltmeler

### 1. WebSocket 502 sorunu -> `protocols h1`

**Belirti:** Tarayici `pipiandkaki.duckdns.org` uzerinden baglaninca WebSocket
surekli kopuyor. Stoat Caddy log'unda `/ws` icin `502 EOF` kaydi.

**Kok neden:** Ana Caddy, HTTP/2 uzerinden gelen WebSocket upgrade isteklerini
(RFC 8441 Extended CONNECT) upstream'deki HTTP/1.1 sunucusuna dogru
aktaramiyordu. HTTP/1.1 ile ayni istek **101 Switching Protocols** donuyordu.

**Cozum:** Ana Caddyfile'da global `servers` blogunda HTTP/2 kapatildi:

```
{
	servers {
		protocols h1
	}
}
```

Tum siteler HTTP/1.1 kullanir. LiveKit ve sohbet sistemi HTTP/1.1 ile
sorunsuz calisir.

### 2. Redis PubSub kopmasi -> `REDIS_PAYLOAD_TYPE=resp2`

**Belirti:** Stoat events log'unda her baglantida:

```
WARN  revolt_bonfire::websocket > Received a None message!
WARN  fred::router::responses   > Ending reader task from redis:6379 due to None
```

**Kok neden:** `fred` 8.0.6 client'i (Stoat events icinde) RESP3 protokolu
kullaniyordu. `valkey/valkey:9-alpine` (Valkey 9.1.2) ile RESP3 PubSub push
frame'lerinde uyumsuzluk var; fred `None` alip okuyucu gorevini sonlandiriyor
ve WebSocket kopuyor.

**Cozum:** `compose.override.yml` icinde events/api/pushd servislerine
`REDIS_PAYLOAD_TYPE: "resp2"` eklendi.

### 3. MongoDB GLIBC rseq uyumsuzlugu

**Belirti:** MongoDB container'i kernel 7.0.0-31'de baslamiyor.

**Cozum:** `compose.override.yml` icinde database servisine:

```yaml
environment:
  GLIBC_TUNABLES: "glibc.pthread.rseq=1"
```

Kernel 7.0.14+ ile bu blok kaldirilabilir.
Ref: https://jira.mongodb.org/browse/SERVER-121912

## compose.override.yml (tam)

```yaml
services:
  caddy:
    ports: !override
      - "8880:80"
  livekit:
    ports: !override
      - "7891:7891"
      - "50200-50300:50200-50300/udp"
  database:
    environment:
      GLIBC_TUNABLES: "glibc.pthread.rseq=1"
  events:
    environment:
      REDIS_PAYLOAD_TYPE: "resp2"
  api:
    environment:
      REDIS_PAYLOAD_TYPE: "resp2"
  pushd:
    environment:
      REDIS_PAYLOAD_TYPE: "resp2"
```

## Dogrulama

```bash
# WebSocket upgrade testi (101 donmeli)
curl -sk -i --max-time 8 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://pipiandkaki.duckdns.org" \
  --resolve pipiandkaki.duckdns.org:443:127.0.0.1 \
  https://pipiandkaki.duckdns.org/ws

# "None message" hatasi olmamali
docker logs stoat-events-1 --since 5m 2>&1 | grep -c "None message"
```

## Notlar

- `secrets.env` dosyasi `/home/psiko/stoat/` altinda, yedeklenmeli.
- CasaOS tamamen kaldirildi; port 80 artik serbest.
- Eski `192.168.1.11:8443` adresi kaldirildi (Caddyfile'dan silindi).
