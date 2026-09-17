import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { q } from './db.js'
import { hashPassword } from './auth.js'
import { roomName } from './rtc.js'

// Muzik botu: "Bot odasi" sesli kanalina katilir; yt-dlp ile indirilen ses
// ffmpeg uzerinden 48 kHz PCM'e cevrilip LiveKit'te mikrofon kanali olarak
// yayinlanir. Komutlar sohbet mesajlariyla verilir: !cal !duraklat !durdur !dc
//
// Spotify dogrudan ses akisi vermedigi icin Spotify linkleri oEmbed ile
// cozulur ve parca adi YouTube aramasinda eslenir (youtube/YouTube Music
// linkleri ise dogrudan yt-dlp'ye verilir).

const API_KEY = process.env.LIVEKIT_API_KEY || ''
const API_SECRET = process.env.LIVEKIT_API_SECRET || ''
const LIVEKIT_HTTP_URL = process.env.LIVEKIT_HTTP_URL || 'http://127.0.0.1:7880'
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || LIVEKIT_HTTP_URL.replace(/^http/i, 'ws')
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp'
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'

const BOT_KULLANICI = 'muzik-botu'
const BOT_AD = 'Müzik Botu'
const BOT_RENK = '#1db954'
const BOT_SESLI_KANAL = 'Bot odası'

const ORNEK_HIZI = 48000
const KANAL_SAYISI = 2
const KARE_MS = 10
const KARE_ORNEK = (ORNEK_HIZI * KARE_MS) / 1000
// Serpistirilmis (interleaved) PCM: int16 sayisi = ornek x kanal.
const KARE_DEGER = KARE_ORNEK * KANAL_SAYISI
const KARE_BAYT = KARE_DEGER * 2

const SPOTIFY_DESEN = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|artist|show)\//i
const SPOTIFY_URI = /^spotify:(track|album|playlist|episode|artist|show):/i

const KOMUTLAR = {
  play: ['çal', 'cal', 'play', 'p', 'oynat', 'müzik', 'muzik'],
  pause: ['duraklat', 'pause', 'beklet'],
  resume: ['devam', 'resume'],
  stop: ['durdur', 'stop', 'kes'],
  dc: ['dc', 'çık', 'cik', 'ayrıl', 'ayril', 'leave', 'kapat'],
  help: ['yardım', 'yardim', 'help', 'komutlar', 'komut']
}

const YARDIM_METNI = [
  '🎵 Müzik botu komutları:',
  '• !çal <şarkı adı veya link> — çalar (YouTube, YouTube Music, Spotify)',
  '• !duraklat — duraklatır, tekrar yazınca devam eder',
  '• !durdur — çalmayı durdurur, kuyruğu temizler',
  '• !dc — bot odasından ayrılır',
  '• !yardım — bu listeyi gösterir',
  "Spotify linkleri: parça adı YouTube'dan eşlenerek çalınır."
].join('\n')

let hub = null
let rtcModul = null
let baglanti = null
let kuyruk = []
let calan = null
let isleyici = false
let duraklatildi = false
let duyuruKanalId = null
let sonBitisDogal = false

export function initMusicBot(options = {}) {
  hub = options.hub || null
  try {
    kurulumuDogrula()
  } catch (e) {
    console.log('muzik-bot: kurulum hatasi: ' + (e?.message || e))
  }
}

export function kapatMusicBot() {
  kuyruk = []
  try {
    calaniDurdur()
  } catch {}
  const b = baglanti
  baglanti = null
  if (b) {
    b.room?.disconnect().catch(() => {})
  }
}

// Sohbet mesaji geldiginde cagrilir. Komut tuketildiyse true doner.
export function muzikKomut({ metin, user, kanal }) {
  const yazi = String(metin || '').trim()
  if (!yazi.startsWith('!') || !kanal || kanal.type !== 'text') return false
  const komut = yazi.slice(1).trim()
  if (!komut) return false
  isle({ komut, user, kanal }).catch((e) => {
    botMesaj(kanal.id, '⚠️ Bir hata oldu: ' + (e?.message || String(e)))
  })
  return true
}

// Bot kullanicisi ve "Bot odasi" sesli kanali yoksa olusturulur.
function kurulumuDogrula() {
  const sunucu = q.get('SELECT id FROM servers ORDER BY id LIMIT 1')
  if (!sunucu) return
  let bot = botKullanici()
  if (!bot) {
    const sifre = hashPassword(randomBytes(24).toString('base64url'))
    const info = q.insert(
      'INSERT INTO users (username, display_name, password_hash, avatar_color, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      [BOT_KULLANICI, BOT_AD, sifre, BOT_RENK, 'member', Date.now()]
    )
    bot = q.get('SELECT * FROM users WHERE id = ?', [Number(info.lastInsertRowid)])
    console.log(`muzik-bot: '${BOT_AD}' kullanicisi olusturuldu (id ${bot.id})`)
  }
  q.insert('INSERT OR IGNORE INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [
    sunucu.id,
    bot.id,
    'member',
    Date.now()
  ])
  if (!sesliKanal()) {
    const pos = q.get("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND type = 'voice'", [sunucu.id]).p
    const info = q.insert(
      "INSERT INTO channels (server_id, name, type, topic, is_private, position, created_at) VALUES (?, ?, 'voice', ?, 0, ?, ?)",
      [sunucu.id, BOT_SESLI_KANAL, 'Müzik botu odası', pos, Date.now()]
    )
    console.log(`muzik-bot: '${BOT_SESLI_KANAL}' sesli kanali olusturuldu (id ${Number(info.lastInsertRowid)})`)
  }
}

function botKullanici() {
  return q.get('SELECT * FROM users WHERE username = ?', [BOT_KULLANICI]) || null
}

function sesliKanal() {
  return q.get("SELECT * FROM channels WHERE type = 'voice' AND name = ? ORDER BY id LIMIT 1", [BOT_SESLI_KANAL]) || null
}

function botMesaj(kanalId, metin) {
  const bot = botKullanici()
  if (!bot || !kanalId) return
  const now = Date.now()
  const info = q.insert(
    'INSERT INTO messages (channel_id, user_id, content, reply_to, created_at) VALUES (?, ?, ?, NULL, ?)',
    [Number(kanalId), bot.id, metin, now]
  )
  const payload = {
    id: Number(info.lastInsertRowid),
    channelId: Number(kanalId),
    userId: bot.id,
    content: metin,
    replyTo: null,
    createdAt: now,
    editedAt: null,
    attachments: []
  }
  if (hub) hub.broadcastChannel(Number(kanalId), { op: 'message_create', payload })
}

function duyur(metin) {
  botMesaj(duyuruKanalId, metin)
}

async function isle({ komut, user, kanal }) {
  const ilkHam = komut.split(/\s+/)[0]
  const ilk = ilkHam.toLocaleLowerCase('tr')
  const kalan = komut.slice(ilkHam.length).trim()
  duyuruKanalId = kanal.id

  if (KOMUTLAR.play.includes(ilk)) return komutuCal(kalan, user)
  if (KOMUTLAR.pause.includes(ilk)) return komutuDuraklat()
  if (KOMUTLAR.resume.includes(ilk)) return komutuDevam()
  if (KOMUTLAR.stop.includes(ilk)) return komutuDurdur()
  if (KOMUTLAR.dc.includes(ilk)) return komutuAyril()
  if (KOMUTLAR.help.includes(ilk)) return duyur(YARDIM_METNI)
  duyur('❓ Bilinmeyen komut. Komut listesi için: !yardım')
}

async function komutuCal(sorgu, user) {
  if (!sorgu) return duyur('❓ Kullanım: !çal <şarkı adı veya link>')
  let hedef
  try {
    hedef = await kaynakCoz(sorgu)
  } catch (e) {
    return duyur('⚠️ Şarkı bulunamadı: ' + (e?.message || String(e)))
  }
  kuyruk.push({ url: hedef.url, baslik: hedef.baslik, isteyen: user?.display_name || '' })
  if (isleyici) duyur(`➕ Sıraya eklendi: ${hedef.baslik}`)
  baslat()
}

async function komutuDuraklat() {
  if (!calan) return duyur('ℹ️ Şu anda çalan bir şarkı yok.')
  if (duraklatildi) return komutuDevam()
  duraklatildi = true
  sinyalGonder(calan.ffmpeg, 'SIGSTOP')
  sinyalGonder(calan.ytdlp, 'SIGSTOP')
  duyur('⏸ Duraklatıldı. Devam etmek için: !devam')
}

async function komutuDevam() {
  if (!calan || !duraklatildi) return duyur('ℹ️ Duraklatılmış bir şarkı yok.')
  duraklatildi = false
  sinyalGonder(calan.ffmpeg, 'SIGCONT')
  sinyalGonder(calan.ytdlp, 'SIGCONT')
  duyur('▶️ Devam ediyor.')
}

async function komutuDurdur() {
  const vardi = Boolean(calan) || kuyruk.length > 0
  kuyruk = []
  calaniDurdur()
  duyur(vardi ? '⏹ Durduruldu, kuyruk temizlendi.' : 'ℹ️ Zaten çalan bir şey yok.')
}

async function komutuAyril() {
  const bagliydi = Boolean(baglanti)
  kuyruk = []
  calaniDurdur()
  await odaBirak()
  duyur(bagliydi ? '👋 Bot odasından ayrıldım. Yeniden çalmak için: !çal <şarkı>' : 'ℹ️ Bot şu anda bir odada değil.')
}

// Sorguyu yt-dlp'nin calabilecegi bir hedefe cevirir.
async function kaynakCoz(sorgu) {
  let hedef = sorgu
  const spotify = SPOTIFY_DESEN.exec(sorgu) || SPOTIFY_URI.exec(sorgu)
  if (spotify) {
    const tur = String(spotify[1] || '').toLowerCase()
    if (tur !== 'track') throw new Error('Spotify için yalnızca tek şarkı (track) linkleri destekleniyor')
    const link = sorgu.match(/https?:\/\/\S+/)?.[0] || sorgu
    const yanit = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(link), {
      signal: AbortSignal.timeout(8000)
    })
    if (!yanit.ok) throw new Error('Spotify linki okunamadı')
    const veri = await yanit.json()
    const ad = String(veri.title || '').trim()
    if (!ad) throw new Error('Spotify parça adı alınamadı')
    hedef = `ytsearch1:${ad}`
  } else if (!/^https?:\/\//i.test(sorgu)) {
    hedef = `ytsearch1:${sorgu}`
  }
  return ytdlpCoz(hedef)
}

async function ytdlpCoz(hedef) {
  const args = [
    '--no-warnings',
    '--no-cache-dir',
    '--no-playlist',
    '--skip-download',
    '--print',
    '%(webpage_url)s',
    '--print',
    '%(title)s',
    hedef
  ]
  const { kod, cikti, hata } = await komutCalistir(YTDLP_BIN, args, 25000)
  const satirlar = cikti.split('\n').map((s) => s.trim()).filter(Boolean)
  if (kod !== 0 || !satirlar.length) throw new Error(kisaHata(hata))
  return { url: satirlar[0], baslik: satirlar[1] || satirlar[0] }
}

function komutCalistir(bin, args, sureMs) {
  return new Promise((resolve) => {
    let cocuk
    try {
      cocuk = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ kod: -1, cikti: '', hata: String(e?.message || e) })
    }
    let cikti = ''
    let hata = ''
    const zaman = setTimeout(() => sureciKes(cocuk), sureMs)
    cocuk.stdout.on('data', (d) => {
      if (cikti.length < 65536) cikti += d.toString()
    })
    cocuk.stderr.on('data', (d) => {
      if (hata.length < 65536) hata += d.toString()
    })
    cocuk.on('error', (e) => {
      clearTimeout(zaman)
      resolve({ kod: -1, cikti, hata: String(e?.message || e) })
    })
    cocuk.on('close', (kod) => {
      clearTimeout(zaman)
      resolve({ kod, cikti, hata })
    })
  })
}

function kisaHata(hata) {
  const satir = String(hata || '').split('\n').map((s) => s.trim()).filter(Boolean).pop() || 'bilinmeyen hata'
  return satir.replace(/^ERROR:\s*/i, '').slice(0, 200)
}

// Kuyrugu sirayla isleyen tek bir dongu; paralel calma olmaz.
function baslat() {
  if (isleyici) return
  isleyici = true
  ;(async () => {
    try {
      while (kuyruk.length) {
        const parca = kuyruk.shift()
        await parcaCal(parca)
      }
    } catch (e) {
      duyur('⚠️ Çalma hatası: ' + (e?.message || String(e)))
    } finally {
      isleyici = false
      duraklatildi = false
      calan = null
    }
    if (sonBitisDogal && baglanti) {
      const sesli = sesliKanal()
      if (sesli && !(await odadaInsanVarMi(sesli.id))) {
        await odaBirak()
        duyur('👋 Kuyruk bitti, odada kimse kalmadı — ayrıldım.')
      }
    }
  })()
}

async function parcaCal(parca) {
  const sesli = sesliKanal()
  if (!sesli) throw new Error('Bot odası kanalı bulunamadı')
  await odaKatil(sesli.id)
  calaniDurdur()
  sonBitisDogal = false

  const ytdlp = spawn(
    YTDLP_BIN,
    ['--no-warnings', '--no-cache-dir', '--no-playlist', '-f', 'bestaudio/best', '-o', '-', parca.url],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const ffmpeg = spawn(
    FFMPEG_BIN,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-re',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      String(ORNEK_HIZI),
      '-ac',
      String(KANAL_SAYISI),
      'pipe:1'
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )

  let ytHata = ''
  ytdlp.stderr.on('data', (d) => {
    if (ytHata.length < 8192) ytHata += d.toString()
  })
  ytdlp.on('error', (e) => {
    ytHata += String(e?.message || e)
  })
  ffmpeg.stderr.on('data', () => {})
  ffmpeg.on('error', () => {})
  ytdlp.stdout.on('error', () => {})
  ffmpeg.stdin.on('error', () => {})
  ytdlp.stdout.pipe(ffmpeg.stdin)

  const kayit = { baslik: parca.baslik, ytdlp, ffmpeg, iptal: false }
  calan = kayit
  duraklatildi = false
  duyur(`🎶 Çalıyor: ${parca.baslik}${parca.isteyen ? ` (${parca.isteyen})` : ''}`)

  const kapanma = new Promise((resolve) => ffmpeg.once('close', (kod) => resolve(kod)))
  try {
    await sesAkit(ffmpeg.stdout, kayit)
  } catch (e) {
    ytHata += ' ' + String(e?.message || e)
  }
  const kod = await kapanma
  if (kayit.iptal) return
  calan = null
  sonBitisDogal = kod === 0
  if (kod !== 0) {
    duyur(`⚠️ "${parca.baslik}" çalınamadı: ${kisaHata(ytHata)}`)
  }
}

// PCM akisini 10 ms'lik LiveKit cercevelerine bolup kaynaga yazar.
async function sesAkit(akinti, kayit) {
  let birikim = Buffer.alloc(0)
  for await (const parca of akinti) {
    if (kayit.iptal) break
    birikim = birikim.length ? Buffer.concat([birikim, parca]) : parca
    while (birikim.length >= KARE_BAYT) {
      const pcm = new Int16Array(KARE_DEGER)
      for (let i = 0; i < KARE_DEGER; i++) pcm[i] = birikim.readInt16LE(i * 2)
      birikim = birikim.subarray(KARE_BAYT)
      if (kayit.iptal || !baglanti?.source) return
      await baglanti.source.captureFrame(new rtcModul.AudioFrame(pcm, ORNEK_HIZI, KANAL_SAYISI, KARE_ORNEK))
      // Kuyruk siserse bekle: gecikme ~400 ms'de sinirli kalir.
      if (baglanti.source.queuedDuration > 400) await baglanti.source.waitForPlayout()
    }
  }
}

async function odaKatil(kanalId) {
  if (baglanti && baglanti.kanalId === kanalId && baglanti.room?.isConnected) return baglanti
  if (baglanti) await odaBirak()
  if (!API_KEY || !API_SECRET) throw new Error('LiveKit anahtarları tanımlı değil')
  const bot = botKullanici()
  if (!bot) throw new Error('Bot kullanıcısı bulunamadı')
  const lib = await rtcYukle()
  const room = new lib.Room()
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: String(bot.id),
    name: bot.display_name,
    ttl: '12h'
  })
  at.addGrant({ room: roomName(kanalId), roomJoin: true, canPublish: true, canSubscribe: false, canPublishData: false })
  await room.connect(LIVEKIT_WS_URL, await at.toJwt(), { autoSubscribe: false, dynacast: false })
  const source = new lib.AudioSource(ORNEK_HIZI, KANAL_SAYISI, 1000)
  const track = lib.LocalAudioTrack.createAudioTrack('muzik', source)
  const secenek = new lib.TrackPublishOptions()
  secenek.source = lib.TrackSource.SOURCE_MICROPHONE
  await room.localParticipant.publishTrack(track, secenek)
  room.on(lib.RoomEvent.Disconnected, () => {
    if (baglanti?.room === room) baglanti = null
  })
  baglanti = { room, source, track, kanalId }
  return baglanti
}

async function odaBirak() {
  const b = baglanti
  baglanti = null
  if (!b) return
  try {
    await b.track?.close?.()
  } catch {}
  try {
    await b.room?.disconnect?.()
  } catch {}
}

async function odadaInsanVarMi(kanalId) {
  try {
    const bot = botKullanici()
    const svc = new RoomServiceClient(LIVEKIT_HTTP_URL, API_KEY, API_SECRET)
    const kisiler = await svc.listParticipants(roomName(kanalId))
    return kisiler.some((p) => Number(p.identity) !== bot?.id)
  } catch {
    return true
  }
}

async function rtcYukle() {
  if (!rtcModul) rtcModul = await import('@livekit/rtc-node')
  return rtcModul
}

function calaniDurdur() {
  const kayit = calan
  calan = null
  duraklatildi = false
  if (!kayit) return
  kayit.iptal = true
  if (kayit.ffmpeg) {
    sinyalGonder(kayit.ffmpeg, 'SIGCONT')
    sureciKes(kayit.ffmpeg)
  }
  if (kayit.ytdlp) {
    sinyalGonder(kayit.ytdlp, 'SIGCONT')
    sureciKes(kayit.ytdlp)
  }
}

function sinyalGonder(cocuk, sinyal) {
  if (!cocuk || cocuk.exitCode !== null || cocuk.signalCode) return
  try {
    cocuk.kill(sinyal)
  } catch {}
}

function sureciKes(cocuk) {
  if (!cocuk || cocuk.exitCode !== null || cocuk.signalCode) return
  try {
    cocuk.kill('SIGKILL')
  } catch {}
}
