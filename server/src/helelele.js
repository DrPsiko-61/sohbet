import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { q } from './db.js'
import { hashPassword } from './auth.js'

// Helelele botu: sohbete "zehra" yazildiginda zehra.png goruntusunu atar.
const BOT_KULLANICI = 'helelele'
const BOT_AD = 'Helelele'
const BOT_RENK = '#ff6b9d'

let hub = null

export function initHelelele(options = {}) {
  hub = options.hub || null
  try {
    kurulumuDogrula()
  } catch (e) {
    console.log('helelele: kurulum hatasi: ' + (e?.message || e))
  }
}

function kurulumuDogrula() {
  const sunucu = q.get('SELECT id FROM servers ORDER BY id LIMIT 1')
  if (!sunucu) return
  let bot = q.get('SELECT * FROM users WHERE username = ?', [BOT_KULLANICI])
  if (!bot) {
    const sifre = hashPassword(randomBytes(24).toString('base64url'))
    const info = q.insert(
      'INSERT INTO users (username, display_name, password_hash, avatar_color, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      [BOT_KULLANICI, BOT_AD, sifre, BOT_RENK, 'bot', Date.now()]
    )
    bot = q.get('SELECT * FROM users WHERE id = ?', [Number(info.lastInsertRowid)])
    console.log(`helelele: '${BOT_AD}' kullanicisi olusturuldu (id ${bot.id})`)
  }
  q.insert('INSERT OR IGNORE INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [
    sunucu.id,
    bot.id,
    'bot',
    Date.now()
  ])
}

// zehra.png dosyasini attachment olarak kaydeder; temizlik silerse yeniden olusturur.
function zehraHazirla() {
  const webDir = process.env.WEB_DIR || './web'
  const path = join(webDir, 'bot', 'zehra.png')
  if (!existsSync(path)) return null
  const mevcut = q.get("SELECT id FROM attachments WHERE filename = 'zehra.png' AND message_id IS NULL ORDER BY id LIMIT 1")
  if (mevcut) return mevcut.id
  const size = statSync(path).size
  const info = q.insert(
    'INSERT INTO attachments (message_id, filename, mime, size, path) VALUES (NULL, ?, ?, ?, ?)',
    ['zehra.png', 'image/png', size, path]
  )
  return Number(info.lastInsertRowid)
}

// Sohbet mesaji geldiginde cagrilir. "zehra" gecen mesajlarda resmi atar.
export function heleleleKomut({ metin, kanal }) {
  const yazi = String(metin || '').trim()
  if (!kanal || kanal.type !== 'text') return false
  if (!/\bzehra\b/i.test(yazi)) return false
  const attId = zehraHazirla()
  botMesaj(kanal.id, '🖼️ Zehra!', attId)
  return true
}

function botMesaj(kanalId, metin, attachmentId) {
  const bot = q.get('SELECT * FROM users WHERE username = ?', [BOT_KULLANICI])
  if (!bot || !kanalId) return
  const now = Date.now()
  const info = q.insert(
    'INSERT INTO messages (channel_id, user_id, content, reply_to, created_at) VALUES (?, ?, ?, NULL, ?)',
    [Number(kanalId), bot.id, metin, now]
  )
  const messageId = Number(info.lastInsertRowid)
  let attachments = []
  if (attachmentId) {
    q.insert('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', [messageId, attachmentId])
    const att = q.get('SELECT * FROM attachments WHERE id = ?', [attachmentId])
    if (att) {
      attachments = [{ id: att.id, url: `/files/${att.id}`, filename: att.filename, mime: att.mime, size: att.size }]
    }
  }
  const payload = {
    id: messageId,
    channelId: Number(kanalId),
    userId: bot.id,
    content: metin,
    replyTo: null,
    createdAt: now,
    editedAt: null,
    attachments
  }
  if (hub) hub.broadcastChannel(Number(kanalId), { op: 'message_create', payload })
}
