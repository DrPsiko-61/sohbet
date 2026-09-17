import { q } from './db.js'
import { hashPassword, ROLES } from './auth.js'

// Ilk kurulum tohumu: yonetici hesabi ve varsayilan sunucu/kanallar.
// Idempotent: kullanicilar tablosu bossa calisir, doluysa hicbir seye dokunmaz.
export function initSeed() {
  const mevcut = q.get('SELECT COUNT(*) AS n FROM users').n
  if (mevcut > 0) return
  const kullanici = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase()
  const sifre = String(process.env.ADMIN_PASSWORD || 'admin')
  const now = Date.now()
  q.insert(
    'INSERT INTO users (username, display_name, password_hash, role, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [kullanici, kullanici, hashPassword(sifre), ROLES.OWNER, '#5865f2', now]
  )
  const user = q.get('SELECT * FROM users WHERE username = ?', [kullanici])
  const info = q.insert('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)', ['Genel', user.id, now])
  const serverId = Number(info.lastInsertRowid)
  q.insert('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [serverId, 'genel', 'text', 0, now])
  q.insert('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [serverId, 'Sohbet', 'voice', 0, now])
  q.insert('INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [serverId, user.id, ROLES.OWNER, now])
  console.log(`tohum: '${kullanici}' yonetici hesabi ve varsayilan sunucu olusturuldu`)
}
