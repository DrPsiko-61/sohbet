import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { q } from './db.js'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
const SESSION_DAYS = 90

export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$')
    if (scheme !== 'scrypt') return false
    const expected = Buffer.from(hash, 'base64url')
    const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p)
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function createSession(userId, userAgent = '') {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  q.insert(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    [sha256(token), userId, now, now + SESSION_DAYS * 86400000, String(userAgent).slice(0, 200)]
  )
  return { token, expiresAt: now + SESSION_DAYS * 86400000 }
}

export function sessionUser(token) {
  if (!token) return null
  const row = q.get(
    `SELECT u.*, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), Date.now()]
  )
  if (!row || row.disabled) return null
  return row
}

export function destroySession(token) {
  if (!token) return
  q.insert('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)])
}

export function destroyUserSessions(userId) {
  q.insert('DELETE FROM sessions WHERE user_id = ?', [userId])
}

export function purgeExpiredSessions() {
  q.insert('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()])
}

export function publicUser(u) {
  if (!u) return null
  const isBot = u.username === 'muzik-botu' || u.role === 'bot'
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url || null,
    status: u.status || null,
    role: isBot ? 'bot' : u.role,
    isBot
  }
}

export const ROLES = { OWNER: 'owner', ADMIN: 'admin', MOD: 'mod', MEMBER: 'member', GUEST: 'guest', BOT: 'bot' }

const RANK = { owner: 4, admin: 3, mod: 2, member: 1, guest: 0, bot: 1 }

export function rank(role) {
  return RANK[role] ?? 0
}

export function atLeast(role, needed) {
  return rank(role) >= rank(needed)
}

export function sanitizeUsername(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (!/^[a-z0-9_.-]{3,20}$/.test(value)) return null
  return value
}

export function sanitizeDisplayName(raw) {
  const value = String(raw || '').trim().replace(/\s+/g, ' ')
  if (value.length < 1 || value.length > 32) return null
  return value
}
