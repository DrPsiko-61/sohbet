import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk'

const API_KEY = process.env.LIVEKIT_API_KEY || ''
const API_SECRET = process.env.LIVEKIT_API_SECRET || ''
const HTTP_URL = process.env.LIVEKIT_HTTP_URL || 'http://livekit:7880'
const PUBLIC_URL = process.env.LIVEKIT_PUBLIC_URL || ''

export const rtcEnabled = Boolean(API_KEY && API_SECRET)

// Yerel ag adresleri (192.168.x, 10.x, 172.16-31.x, localhost).
const YEREL_ADRES = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost$|\[::1\])/i

export const roomName = (channelId) => `ch-${channelId}`

const receiver = rtcEnabled ? new WebhookReceiver(API_KEY, API_SECRET) : null

/// Istemciye hangi LiveKit adresi verilecek?
///
/// Router'in NAT dongusu (hairpin) kapali oldugu icin ev agindaki cihazlar
/// public alan adina ULASAMAZ. Bu yuzden LAN'dan gelen istemciye ayni yerel
/// adres uzerindeki /livekit yolu verilir (Caddy oradan LiveKit'e yonlendirir).
/// Dis adresten gelen istemciye ise her zamanki public adres verilir.
export function voiceUrlFor(host) {
  if (!host) return PUBLIC_URL
  const sadeceHost = String(host).split(':')[0].toLowerCase()
  if (YEREL_ADRES.test(sadeceHost)) {
    // Port varsa korunur; olmasi gereken sey zaten 443.
    const port = String(host).includes(':') ? String(host).split(':')[1] : ''
    return `wss://${sadeceHost}${port ? ':' + port : ''}/livekit`
  }
  return PUBLIC_URL
}

export async function createVoiceToken({ user, channelId, canPublish = true, host = '' }) {
  if (!rtcEnabled) throw new Error('rtc_disabled')
  const room = roomName(channelId)
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: String(user.id),
    name: user.display_name,
    ttl: '6h',
    metadata: JSON.stringify({ username: user.username })
  })
  at.addGrant({
    room,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: true
  })
  return { token: await at.toJwt(), room, url: voiceUrlFor(host) }
}

export async function listVoiceParticipants(channelId) {
  if (!rtcEnabled) return []
  try {
    const svc = new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET)
    const rooms = await svc.listRooms([roomName(channelId)])
    if (!rooms.length) return []
    const parts = await svc.listParticipants(roomName(channelId))
    return parts.map((p) => Number(p.identity)).filter((n) => Number.isFinite(n))
  } catch {
    return []
  }
}

// LiveKit protobuf nesnelerinde enum alanlari bellekte sayi olarak durur,
// JSON'a cevrilince metin olur. Ikisini de karsilayacak sekilde normalize ediyoruz;
// aksi halde source === 'CAMERA' karsilastirmasi hicbir zaman tutmaz.
const TRACK_SOURCE = { 0: 'UNKNOWN', 1: 'CAMERA', 2: 'MICROPHONE', 3: 'SCREEN_SHARE', 4: 'SCREEN_SHARE_AUDIO' }
const TRACK_TYPE = { 0: 'UNKNOWN', 1: 'AUDIO', 2: 'VIDEO' }

function enumName(map, raw) {
  if (typeof raw === 'number') return map[raw] || 'UNKNOWN'
  const value = String(raw ?? '').toUpperCase()
  return value || 'UNKNOWN'
}

export async function verifyWebhook(body, authHeader) {
  if (!receiver) return null
  try {
    const event = await receiver.receive(body, authHeader)
    if (!event) return null
    return {
      event: String(event.event || ''),
      room: event.room ? { name: event.room.name } : null,
      participant: event.participant ? { identity: String(event.participant.identity ?? '') } : null,
      track: event.track
        ? {
            source: enumName(TRACK_SOURCE, event.track.source),
            type: enumName(TRACK_TYPE, event.track.type),
            muted: Boolean(event.track.muted)
          }
        : null
    }
  } catch {
    return null
  }
}
