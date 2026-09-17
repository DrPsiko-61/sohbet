import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { q, audit } from './db.js'
import {
  hashPassword, verifyPassword, createSession, sessionUser, destroySession,
  destroyUserSessions, publicUser, atLeast, ROLES, sanitizeUsername, sanitizeDisplayName
} from './auth.js'
import { createVoiceToken, verifyWebhook, rtcEnabled } from './rtc.js'
import { muzikKomut } from './bot.js'

const DATA_DIR = process.env.DATA_DIR || './data'
const FILES_DIR = join(DATA_DIR, 'files')
const WEB_DIR = process.env.WEB_DIR || './web'
mkdirSync(FILES_DIR, { recursive: true })

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024)
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false'
const INVITE_CODE = process.env.INVITE_CODE || ''

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.exe': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive'
}

// Kurulum dosyasi: tarayicida acilmaya calisilmasin, dogrudan indirilsin
const DOWNLOAD_EXTS = new Set(['.exe', '.msi', '.zip', '.apk'])

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(body)
}

function readJson(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseCookies(header = '') {
  const out = {}
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

export function tokenFromRequest(req) {
  const cookie = parseCookies(req.headers.cookie).sid
  if (cookie) return cookie
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  return null
}

function setSessionCookie(token, maxAgeSeconds) {
  const parts = [
    `sid=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`
  ]
  if (COOKIE_SECURE) parts.push('Secure')
  return parts.join('; ')
}

const buckets = new Map()
function rateLimit(key, max, windowMs) {
  const now = Date.now()
  const entry = buckets.get(key)
  if (!entry || now - entry.start > windowMs) {
    buckets.set(key, { start: now, count: 1 })
    return true
  }
  entry.count += 1
  return entry.count <= max
}

function messageRow(row) {
  const attachments = q.all('SELECT id, filename, mime, size FROM attachments WHERE message_id = ?', [row.id])
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    content: row.content,
    replyTo: row.reply_to || null,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    attachments: attachments.map((a) => ({
      id: a.id,
      url: `/files/${a.id}`,
      filename: a.filename,
      mime: a.mime,
      size: a.size
    }))
  }
}

const PERM_DELETE_OTHERS = [ROLES.OWNER, ROLES.ADMIN, ROLES.MOD]

function memberRole(userId, serverId) {
  const m = q.get('SELECT role FROM members WHERE server_id = ? AND user_id = ?', [serverId, userId])
  return m ? m.role : null
}

function effectiveRole(user, serverId) {
  if (user.role === ROLES.OWNER) return ROLES.OWNER
  const role = memberRole(user.id, serverId)
  if (!role) return null
  return role
}

function visibleChannels(user, serverId) {
  const channels = q.all('SELECT * FROM channels WHERE server_id = ? ORDER BY type, position, id', [serverId])
  if (atLeast(effectiveRole(user, serverId) || user.role, ROLES.ADMIN)) return channels
  const allowed = new Set(
    q.all('SELECT channel_id FROM channel_access WHERE user_id = ?', [user.id]).map((r) => r.channel_id)
  )
  return channels.filter((c) => !c.is_private || allowed.has(c.id))
}

function channelAccessible(user, channelId) {
  const channel = q.get('SELECT * FROM channels WHERE id = ?', [channelId])
  if (!channel) return { channel: null }
  const role = effectiveRole(user, channel.server_id)
  if (!role) return { channel: null }
  if (channel.is_private && !atLeast(role, ROLES.ADMIN)) {
    const ok = q.get('SELECT 1 AS ok FROM channel_access WHERE channel_id = ? AND user_id = ?', [channelId, user.id])
    if (!ok) return { channel: null }
  }
  return { channel, role }
}

export function buildRoutes({ hub }) {
  const routes = []
  const add = (method, pattern, handler) => {
    const names = []
    const regex = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
      names.push(name)
      return '([^/]+)'
    }) + '$')
    routes.push({ method, regex, names, handler })
  }

  const auth = (handler, minRole = null) => async (ctx) => {
    const user = sessionUser(tokenFromRequest(ctx.req))
    if (!user) return send(ctx.res, 401, { error: 'unauthorized' })
    ctx.user = user
    if (minRole && !atLeast(user.role, minRole)) return send(ctx.res, 403, { error: 'forbidden' })
    return handler(ctx)
  }

  add('POST', '/api/auth/register', async ({ req, res }) => {
    const body = await readJson(req)
    const username = sanitizeUsername(body.username)
    const displayName = sanitizeDisplayName(body.displayName || body.username)
    const password = String(body.password || '')
    if (!username || !displayName) return send(res, 400, { error: 'invalid_username' })
    if (password.length < 8) return send(res, 400, { error: 'weak_password' })
    const total = q.get('SELECT COUNT(*) AS n FROM users').n
    if (total > 0) {
      const code = String(body.inviteCode || '')
      if (!INVITE_CODE || code !== INVITE_CODE) return send(res, 403, { error: 'invite_required' })
    }
    if (q.get('SELECT id FROM users WHERE username = ?', [username])) return send(res, 409, { error: 'username_taken' })
    const isFirst = total === 0
    const now = Date.now()
    q.insert(
      'INSERT INTO users (username, display_name, password_hash, role, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [username, displayName, hashPassword(password), isFirst ? ROLES.OWNER : ROLES.MEMBER, colorFor(username), now]
    )
    const user = q.get('SELECT * FROM users WHERE username = ?', [username])
    if (isFirst) {
      const info = q.insert('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)', ['Genel', user.id, now])
      const serverId = Number(info.lastInsertRowid)
      q.insert('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [serverId, 'genel', 'text', 0, now])
      q.insert('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [serverId, 'Sohbet', 'voice', 0, now])
    }
    q.insert(
      'INSERT INTO members (server_id, user_id, role, joined_at) SELECT id, ?, ?, ? FROM servers',
      [user.id, isFirst ? ROLES.OWNER : ROLES.MEMBER, now]
    )
    const { token } = createSession(user.id, req.headers['user-agent'])
    audit(user.id, 'user.register', { username })
    hub.broadcastAll({ op: 'user_create', payload: publicUser(user) })
    return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': setSessionCookie(token, 90 * 86400) })
  })

  add('POST', '/api/auth/login', async ({ req, res }) => {
    const body = await readJson(req)
    if (!rateLimit(`login:${req.socket.remoteAddress}`, 10, 60000)) return send(res, 429, { error: 'too_many_attempts' })
    const username = sanitizeUsername(body.username)
    const user = username ? q.get('SELECT * FROM users WHERE username = ?', [username]) : null
    if (!user || user.disabled) return send(res, 401, { error: 'invalid_credentials' })
    if (!verifyPassword(String(body.password || ''), user.password_hash)) {
      audit(null, 'user.login_failed', { username })
      return send(res, 401, { error: 'invalid_credentials' })
    }
    const { token } = createSession(user.id, req.headers['user-agent'])
    audit(user.id, 'user.login', null)
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': setSessionCookie(token, 90 * 86400) })
  })

  add('POST', '/api/auth/logout', auth(async ({ req, res }) => {
    destroySession(tokenFromRequest(req))
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' })
  }))

  add('GET', '/api/bootstrap', auth(async ({ res, user }) => {
    const servers = q.all('SELECT * FROM servers ORDER BY id')
    const members = q.all(
      `SELECT m.server_id, m.role, m.joined_at, u.id, u.username, u.display_name, u.avatar_color
         FROM members m JOIN users u ON u.id = m.user_id ORDER BY u.display_name`
    )
    const users = q.all('SELECT * FROM users ORDER BY display_name').map((u) => ({
      ...publicUser(u),
      disabled: Boolean(u.disabled),
      createdAt: u.created_at,
      lastSeen: hub.lastSeen(u.id) || null
    }))
    return send(res, 200, {
      user: publicUser(user),
      // Davet kodu yalnizca yonetici ve sahibine gonderilir; uyeler bos deger alir.
      inviteCode: atLeast(user.role, ROLES.ADMIN) ? INVITE_CODE : '',
      rtc: { enabled: rtcEnabled, url: process.env.LIVEKIT_PUBLIC_URL || '' },
      online: hub.onlineIds(),
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        ownerId: s.owner_id,
        channels: visibleChannels(user, s.id).map((c) => ({
          id: c.id,
          serverId: c.server_id,
          name: c.name,
          type: c.type,
          topic: c.topic,
          isPrivate: Boolean(c.is_private),
          position: c.position
        })),
        members: members.filter((m) => m.server_id === s.id).map((m) => ({
          userId: m.id,
          role: m.role,
          username: m.username,
          displayName: m.display_name,
          avatarColor: m.avatar_color
        }))
      })),
      users,
      voice: hub.voiceSnapshot()
    })
  }))

  add('GET', '/api/channels/:id/messages', auth(async ({ res, user, params, url }) => {
    const { channel } = channelAccessible(user, Number(params.id))
    if (!channel) return send(res, 404, { error: 'not_found' })
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100)
    const before = Number(url.searchParams.get('before') || 0)
    const rows = before
      ? q.all('SELECT * FROM messages WHERE channel_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?', [channel.id, before, limit])
      : q.all('SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?', [channel.id, limit])
    return send(res, 200, { messages: rows.reverse().map(messageRow) })
  }))

  add('POST', '/api/channels/:id/messages', auth(async ({ req, res, user, params }) => {
    const { channel } = channelAccessible(user, Number(params.id))
    if (!channel) return send(res, 404, { error: 'not_found' })
    if (channel.type === 'voice') return send(res, 400, { error: 'not_text_channel' })
    if (user.role === ROLES.GUEST) return send(res, 403, { error: 'read_only' })
    if (!rateLimit(`msg:${user.id}`, 12, 10000)) return send(res, 429, { error: 'slow_down' })
    const body = await readJson(req)
    const content = String(body.content || '').slice(0, 4000)
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.slice(0, 6).map(Number) : []
    if (!content.trim() && !attachmentIds.length) return send(res, 400, { error: 'empty_message' })
    const now = Date.now()
    const info = q.insert(
      'INSERT INTO messages (channel_id, user_id, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?)',
      [channel.id, user.id, content, body.replyTo ? Number(body.replyTo) : null, now]
    )
    const messageId = Number(info.lastInsertRowid)
    for (const id of attachmentIds) {
      q.insert('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', [messageId, id])
    }
    const row = q.get('SELECT * FROM messages WHERE id = ?', [messageId])
    const payload = messageRow(row)
    hub.broadcastChannel(channel.id, { op: 'message_create', payload })
    // "!" ile baslayan mesajlar muzik botu komutu olabilir.
    muzikKomut({ metin: content, user, kanal: channel })
    return send(res, 201, { message: payload })
  }))

  add('PATCH', '/api/messages/:id', auth(async ({ req, res, user, params }) => {
    const row = q.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(params.id)])
    if (!row) return send(res, 404, { error: 'not_found' })
    const { channel } = channelAccessible(user, row.channel_id)
    if (!channel) return send(res, 404, { error: 'not_found' })
    if (row.user_id !== user.id) return send(res, 403, { error: 'forbidden' })
    const body = await readJson(req)
    const content = String(body.content || '').slice(0, 4000)
    q.insert('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [content, Date.now(), row.id])
    const payload = messageRow(q.get('SELECT * FROM messages WHERE id = ?', [row.id]))
    hub.broadcastChannel(channel.id, { op: 'message_update', payload })
    return send(res, 200, { message: payload })
  }))

  add('DELETE', '/api/messages/:id', auth(async ({ res, user, params }) => {
    const row = q.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(params.id)])
    if (!row) return send(res, 404, { error: 'not_found' })
    const { channel } = channelAccessible(user, row.channel_id)
    if (!channel) return send(res, 404, { error: 'not_found' })
    const mine = row.user_id === user.id
    if (!mine && !atLeast(user.role, ROLES.MOD)) return send(res, 403, { error: 'forbidden' })
    q.insert('UPDATE messages SET deleted_at = ?, content = ? WHERE id = ?', [Date.now(), '', row.id])
    audit(user.id, 'message.delete', { messageId: row.id, channelId: channel.id }, channel.server_id)
    hub.broadcastChannel(channel.id, { op: 'message_delete', payload: { id: row.id, channelId: channel.id } })
    return send(res, 200, { ok: true })
  }))

  add('POST', '/api/channels/:id/upload', auth(async ({ req, res, user, params, url }) => {
    const { channel } = channelAccessible(user, Number(params.id))
    if (!channel) return send(res, 404, { error: 'not_found' })
    if (user.role === ROLES.GUEST) return send(res, 403, { error: 'read_only' })
    const mime = String(url.searchParams.get('mime') || req.headers['content-type'] || 'application/octet-stream')
    const name = String(url.searchParams.get('name') || 'dosya').slice(0, 120).replace(/[^\w.\- ()\u00c0-\u024f]/g, '_')
    let buffer
    try {
      buffer = await readRaw(req, MAX_UPLOAD)
    } catch {
      return send(res, 413, { error: 'file_too_large', max: MAX_UPLOAD })
    }
    if (!buffer.length) return send(res, 400, { error: 'empty_file' })
    const info = q.insert(
      'INSERT INTO attachments (message_id, filename, mime, size, path) VALUES (NULL, ?, ?, ?, ?)',
      [name, mime, buffer.length, 'pending']
    )
    const id = Number(info.lastInsertRowid)
    const filePath = join(FILES_DIR, String(id))
    writeFileSync(filePath, buffer)
    q.insert('UPDATE attachments SET path = ? WHERE id = ?', [filePath, id])
    return send(res, 201, { attachment: { id, url: `/files/${id}`, filename: name, mime, size: buffer.length } })
  }))

  add('POST', '/api/channels/:id/voice-token', auth(async ({ req, res, user, params }) => {
    if (!rtcEnabled) return send(res, 503, { error: 'rtc_disabled' })
    const { channel } = channelAccessible(user, Number(params.id))
    if (!channel) return send(res, 404, { error: 'not_found' })
    if (channel.type !== 'voice') return send(res, 400, { error: 'not_voice_channel' })
    // Istemcinin hangi adresten geldigi onemli: LAN'dan gelen cihaza yerel
    // LiveKit adresi verilir (bkz. rtc.js voiceUrlFor).
    const data = await createVoiceToken({ user, channelId: channel.id, host: req.headers.host || '' })
    return send(res, 200, data)
  }))

  add('POST', '/api/rtc/webhook', async ({ req, res }) => {
    const raw = await readRaw(req, 1024 * 1024)
    const event = await verifyWebhook(raw.toString('utf8'), req.headers.authorization)
    if (!event) return send(res, 401, { error: 'invalid_webhook' })
    if (process.env.WEBHOOK_DEBUG === 'true' && String(event.event).startsWith('track_')) {
      console.log('WEBHOOK_DEBUG ' + JSON.stringify(event))
    }
    hub.handleRtcEvent(event)
    return send(res, 200, { ok: true })
  })

  add('GET', '/api/audit', auth(async ({ res, user, url }) => {
    if (!atLeast(user.role, ROLES.MOD)) return send(res, 403, { error: 'forbidden' })
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 300)
    const rows = q.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit])
    return send(res, 200, {
      entries: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        action: r.action,
        detail: r.detail ? JSON.parse(r.detail) : null,
        createdAt: r.created_at
      }))
    })
  }))

  add('GET', '/api/panel/state', auth(async ({ res, user }) => {
    if (!atLeast(user.role, ROLES.MOD)) return send(res, 403, { error: 'forbidden' })
    const users = q.all('SELECT * FROM users ORDER BY display_name').map((u) => ({
      ...publicUser(u),
      disabled: Boolean(u.disabled),
      createdAt: u.created_at,
      lastSeen: hub.lastSeen(u.id) || null
    }))
    const channels = q.all('SELECT * FROM channels ORDER BY server_id, type, position, id').map((c) => ({
      id: c.id,
      serverId: c.server_id,
      name: c.name,
      type: c.type,
      topic: c.topic,
      isPrivate: Boolean(c.is_private),
      access: q.all('SELECT user_id FROM channel_access WHERE channel_id = ?', [c.id]).map((r) => r.user_id)
    }))
    const servers = q.all('SELECT * FROM servers ORDER BY id').map((s) => ({
      id: s.id,
      name: s.name,
      ownerId: s.owner_id,
      memberCount: q.get('SELECT COUNT(*) AS n FROM members WHERE server_id = ?', [s.id]).n,
      messageCount: q.get(
        'SELECT COUNT(*) AS n FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?) AND deleted_at IS NULL',
        [s.id]
      ).n
    }))
    return send(res, 200, { users, channels, servers, voice: hub.voiceSnapshot() })
  }))

  add('POST', '/api/servers', auth(async ({ req, res, user }) => {
    if (!atLeast(user.role, ROLES.OWNER)) return send(res, 403, { error: 'forbidden' })
    const body = await readJson(req)
    const name = String(body.name || '').trim().slice(0, 60)
    if (!name) return send(res, 400, { error: 'invalid_name' })
    const now = Date.now()
    const info = q.insert('INSERT INTO servers (name, owner_id, created_at) VALUES (?, ?, ?)', [name, user.id, now])
    const serverId = Number(info.lastInsertRowid)
    q.insert('INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [serverId, user.id, ROLES.OWNER, now])
    q.insert('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [serverId, 'genel', 'text', 0, now])
    q.insert('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [serverId, 'Sohbet', 'voice', 0, now])
    audit(user.id, 'server.create', { name }, serverId)
    hub.broadcastAll({ op: 'refresh' })
    return send(res, 201, { serverId })
  }))

  add('PATCH', '/api/servers/:id', auth(async ({ req, res, user, params }) => {
    const serverId = Number(params.id)
    if (!atLeast(effectiveRole(user, serverId) || user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
    const body = await readJson(req)
    const name = String(body.name || '').trim().slice(0, 60)
    if (!name) return send(res, 400, { error: 'invalid_name' })
    q.insert('UPDATE servers SET name = ? WHERE id = ?', [name, serverId])
    audit(user.id, 'server.rename', { name }, serverId)
    hub.broadcastAll({ op: 'refresh' })
    return send(res, 200, { ok: true })
  }))

  add('POST', '/api/channels', auth(async ({ req, res, user }) => {
    const body = await readJson(req)
    const serverId = Number(body.serverId)
    if (!atLeast(effectiveRole(user, serverId) || user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
    const name = String(body.name || '').trim().slice(0, 40)
    const type = ['text', 'voice'].includes(body.type) ? body.type : 'text'
    if (!name) return send(res, 400, { error: 'invalid_name' })
    const now = Date.now()
    const pos = q.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND type = ?', [serverId, type]).p
    const info = q.insert(
      'INSERT INTO channels (server_id, name, type, topic, is_private, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [serverId, name, type, String(body.topic || '').slice(0, 200) || null, body.isPrivate ? 1 : 0, pos, now]
    )
    const channelId = Number(info.lastInsertRowid)
    if (body.isPrivate && Array.isArray(body.access)) {
      for (const uid of body.access.map(Number)) {
        if (Number.isFinite(uid)) q.insert('INSERT OR IGNORE INTO channel_access (channel_id, user_id) VALUES (?, ?)', [channelId, uid])
      }
    }
    audit(user.id, 'channel.create', { name, type }, serverId)
    hub.broadcastAll({ op: 'refresh' })
    return send(res, 201, { channelId })
  }))

  add('PATCH', '/api/channels/:id', auth(async ({ req, res, user, params }) => {
    const channelId = Number(params.id)
    const channel = q.get('SELECT * FROM channels WHERE id = ?', [channelId])
    if (!channel) return send(res, 404, { error: 'not_found' })
    if (!atLeast(effectiveRole(user, channel.server_id) || user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
    const body = await readJson(req)
    const name = body.name === undefined ? channel.name : String(body.name).trim().slice(0, 40)
    if (!name) return send(res, 400, { error: 'invalid_name' })
    const topic = body.topic === undefined ? channel.topic : String(body.topic).slice(0, 200) || null
    const isPrivate = body.isPrivate === undefined ? channel.is_private : body.isPrivate ? 1 : 0
    q.insert('UPDATE channels SET name = ?, topic = ?, is_private = ? WHERE id = ?', [name, topic, isPrivate, channelId])
    if (Array.isArray(body.access)) {
      q.insert('DELETE FROM channel_access WHERE channel_id = ?', [channelId])
      for (const uid of body.access.map(Number)) {
        if (Number.isFinite(uid)) q.insert('INSERT OR IGNORE INTO channel_access (channel_id, user_id) VALUES (?, ?)', [channelId, uid])
      }
    }
    audit(user.id, 'channel.update', { channelId, name }, channel.server_id)
    hub.broadcastAll({ op: 'refresh' })
    return send(res, 200, { ok: true })
  }))

  add('DELETE', '/api/channels/:id', auth(async ({ res, user, params }) => {
    const channelId = Number(params.id)
    const channel = q.get('SELECT * FROM channels WHERE id = ?', [channelId])
    if (!channel) return send(res, 404, { error: 'not_found' })
    if (!atLeast(effectiveRole(user, channel.server_id) || user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
    q.insert('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)', [channelId])
    q.insert('DELETE FROM messages WHERE channel_id = ?', [channelId])
    q.insert('DELETE FROM channels WHERE id = ?', [channelId])
    hub.dropVoiceChannel(channelId)
    audit(user.id, 'channel.delete', { name: channel.name }, channel.server_id)
    hub.broadcastAll({ op: 'refresh' })
    return send(res, 200, { ok: true })
  }))

  add('POST', '/api/users', auth(async ({ req, res, user }) => {
    if (!atLeast(user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
    const body = await readJson(req)
    const username = sanitizeUsername(body.username)
    const displayName = sanitizeDisplayName(body.displayName || body.username)
    const password = String(body.password || '')
    const requestedRole = ['owner', 'admin', 'mod', 'member', 'guest'].includes(body.role) ? body.role : ROLES.MEMBER
    if (!username || !displayName) return send(res, 400, { error: 'invalid_username' })
    if (password.length < 8) return send(res, 400, { error: 'weak_password' })
    if (requestedRole === ROLES.OWNER && user.role !== ROLES.OWNER) return send(res, 403, { error: 'forbidden' })
    if (requestedRole === ROLES.ADMIN && user.role !== ROLES.OWNER) return send(res, 403, { error: 'forbidden' })
    if (q.get('SELECT id FROM users WHERE username = ?', [username])) return send(res, 409, { error: 'username_taken' })
    const now = Date.now()
    q.insert(
      'INSERT INTO users (username, display_name, password_hash, role, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [username, displayName, hashPassword(password), requestedRole, colorFor(username), now]
    )
    const created = q.get('SELECT * FROM users WHERE username = ?', [username])
    const servers = q.all('SELECT id FROM servers')
    for (const s of servers) {
      q.insert('INSERT OR IGNORE INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [s.id, created.id, requestedRole, now])
    }
    audit(user.id, 'user.create', { username, role: requestedRole })
    hub.broadcastAll({ op: 'user_create', payload: publicUser(created) })
    return send(res, 201, { user: publicUser(created) })
  }))

  add('PATCH', '/api/users/:id', auth(async ({ req, res, user, params }) => {
    const targetId = Number(params.id)
    const target = q.get('SELECT * FROM users WHERE id = ?', [targetId])
    if (!target) return send(res, 404, { error: 'not_found' })
    const body = await readJson(req)
    const selfEdit = targetId === user.id
    if (!selfEdit && !atLeast(user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
    if (selfEdit && !atLeast(user.role, ROLES.MOD) && (body.role || body.disabled !== undefined)) {
      return send(res, 403, { error: 'forbidden' })
    }
    if (body.role !== undefined) {
      if (!atLeast(user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
      if (['owner', 'admin'].includes(body.role) && user.role !== ROLES.OWNER) return send(res, 403, { error: 'forbidden' })
      if (target.role === ROLES.OWNER && user.role !== ROLES.OWNER) return send(res, 403, { error: 'forbidden' })
      q.insert('UPDATE users SET role = ? WHERE id = ?', [body.role, targetId])
      q.insert('UPDATE members SET role = ? WHERE user_id = ?', [body.role, targetId])
    }
    if (body.displayName !== undefined) {
      const displayName = sanitizeDisplayName(body.displayName)
      if (!displayName) return send(res, 400, { error: 'invalid_display_name' })
      q.insert('UPDATE users SET display_name = ? WHERE id = ?', [displayName, targetId])
    }
    if (body.avatarColor !== undefined) {
      const color = String(body.avatarColor)
      if (/^#[0-9a-f]{6}$/i.test(color)) q.insert('UPDATE users SET avatar_color = ? WHERE id = ?', [color, targetId])
    }
    if (body.password !== undefined) {
      if (!selfEdit && !atLeast(user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
      const password = String(body.password)
      if (password.length < 8) return send(res, 400, { error: 'weak_password' })
      q.insert('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), targetId])
      if (!selfEdit) destroyUserSessions(targetId)
      audit(user.id, 'user.password_reset', { userId: targetId })
    }
    if (body.disabled !== undefined) {
      if (!atLeast(user.role, ROLES.ADMIN)) return send(res, 403, { error: 'forbidden' })
      if (targetId === user.id) return send(res, 400, { error: 'cannot_disable_self' })
      const disabled = body.disabled ? 1 : 0
      q.insert('UPDATE users SET disabled = ? WHERE id = ?', [disabled, targetId])
      if (disabled) {
        destroyUserSessions(targetId)
        hub.kickUser(targetId)
      }
      audit(user.id, disabled ? 'user.disable' : 'user.enable', { userId: targetId })
    }
    const updated = q.get('SELECT * FROM users WHERE id = ?', [targetId])
    hub.broadcastAll({ op: 'user_update', payload: publicUser(updated) })
    return send(res, 200, { user: publicUser(updated) })
  }))

  add('POST', '/api/users/:id/kick', auth(async ({ res, user, params }) => {
    const targetId = Number(params.id)
    if (!atLeast(user.role, ROLES.MOD)) return send(res, 403, { error: 'forbidden' })
    if (targetId === user.id) return send(res, 400, { error: 'cannot_kick_self' })
    hub.kickUser(targetId)
    audit(user.id, 'user.kick', { userId: targetId })
    return send(res, 200, { ok: true })
  }))

  add('DELETE', '/api/users/:id', auth(async ({ res, user, params }) => {
    const targetId = Number(params.id)
    if (user.role !== ROLES.OWNER) return send(res, 403, { error: 'forbidden' })
    const target = q.get('SELECT * FROM users WHERE id = ?', [targetId])
    if (!target) return send(res, 404, { error: 'not_found' })
    if (target.role === ROLES.OWNER) return send(res, 400, { error: 'cannot_delete_owner' })
    hub.kickUser(targetId)
    q.insert('DELETE FROM users WHERE id = ?', [targetId])
    audit(user.id, 'user.delete', { username: target.username })
    hub.broadcastAll({ op: 'user_delete', payload: { userId: targetId } })
    return send(res, 200, { ok: true })
  }))

  return routes
}

function colorFor(seed) {
  const palette = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#00b0f4', '#f47fff', '#faa61a']
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 100000
  return palette[hash % palette.length]
}

export function serveFile(req, res, pathname) {
  if (pathname.startsWith('/files/')) {
    const id = Number(pathname.slice(7))
    const att = q.get('SELECT * FROM attachments WHERE id = ?', [id])
    if (!att || !att.path || att.path === 'pending' || !existsSync(att.path)) {
      return send(res, 404, { error: 'not_found' })
    }
    const stat = statSync(att.path)
    const download = pathname.endsWith('/download')
    res.writeHead(200, {
      'Content-Type': att.mime || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`
    })
    return createReadStream(att.path).pipe(res)
  }

  const relative = pathname === '/' ? '/index.html' : pathname
  const target = normalize(join(WEB_DIR, relative))
  if (!target.startsWith(normalize(WEB_DIR))) return send(res, 403, { error: 'forbidden' })
  if (!existsSync(target) || !statSync(target).isFile()) {
    // /ses/* gibi medya dosyalari yoksa SPA fallback'ine dusmesin: tarayici
    // "audio" ile yuklerken bozuk icerik yerine 404 alip hata yonetimini
    // kendisi yapar.
    if (pathname.startsWith('/ses/')) return send(res, 404, { error: 'not_found' })
    const fallback = join(WEB_DIR, 'index.html')
    if (existsSync(fallback)) {
      const html = statSync(fallback).size
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Content-Length': html, 'Cache-Control': 'no-cache' })
      return createReadStream(fallback).pipe(res)
    }
    return send(res, 404, { error: 'not_found' })
  }
  const stat = statSync(target)
  const ext = extname(target).toLowerCase()
  const immutable = /\.(woff2|png|webp|jpg|svg|ico)$/.test(ext)
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache'
  }
  if (DOWNLOAD_EXTS.has(ext)) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(target.split(/[\\/]/).pop())}`
  }
  res.writeHead(200, headers)
  return createReadStream(target).pipe(res)
}

export function cleanupOrphans() {
  const cutoff = Date.now() - 86400000
  const orphans = q.all('SELECT * FROM attachments WHERE message_id IS NULL')
  let removed = 0
  for (const att of orphans) {
    if (!att.path || att.path === 'pending') continue
    if (existsSync(att.path) && statSync(att.path).mtimeMs > cutoff) continue
    try {
      unlinkSync(att.path)
    } catch {}
    q.insert('DELETE FROM attachments WHERE id = ?', [att.id])
    removed += 1
  }
  return removed
}

export { send, readJson, readRaw, MIME_TYPES, MAX_UPLOAD }
