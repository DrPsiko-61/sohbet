import { WebSocketServer } from 'ws'
import { q } from './db.js'
import { sessionUser, atLeast, ROLES } from './auth.js'
import { tokenFromRequest } from './http.js'

const HEARTBEAT_MS = 30000

export function createHub(server) {
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: true, maxPayload: 256 * 1024 })
  const clients = new Map()
  const seen = new Map()
  const voice = new Map()

  function channelViewers(channelId) {
    const channel = q.get('SELECT * FROM channels WHERE id = ?', [channelId])
    if (!channel) return []
    const owners = new Set(q.all("SELECT id FROM users WHERE role = 'owner'").map((r) => r.id))
    const access = new Set(q.all('SELECT user_id FROM channel_access WHERE channel_id = ?', [channelId]).map((r) => r.user_id))
    const members = q.all('SELECT user_id, role FROM members WHERE server_id = ?', [channel.server_id])
    return members
      .filter((m) => !channel.is_private || access.has(m.user_id) || atLeast(m.role, ROLES.ADMIN) || owners.has(m.user_id))
      .map((m) => m.user_id)
  }

  function canSee(channelId, userId) {
    const channel = q.get('SELECT * FROM channels WHERE id = ?', [channelId])
    if (!channel) return null
    const user = q.get('SELECT * FROM users WHERE id = ?', [userId])
    if (!user || user.disabled) return null
    if (user.role === ROLES.OWNER) return channel
    const member = q.get('SELECT role FROM members WHERE server_id = ? AND user_id = ?', [channel.server_id, userId])
    if (!member) return null
    if (channel.is_private && !atLeast(member.role, ROLES.ADMIN)) {
      const ok = q.get('SELECT 1 AS ok FROM channel_access WHERE channel_id = ? AND user_id = ?', [channelId, userId])
      if (!ok) return null
    }
    return channel
  }

  function sendTo(userId, message) {
    const sockets = clients.get(userId)
    if (!sockets) return
    const data = JSON.stringify(message)
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  function broadcastAll(message) {
    const data = JSON.stringify(message)
    for (const sockets of clients.values()) {
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(data)
      }
    }
  }

  function broadcastChannel(channelId, message) {
    const data = JSON.stringify(message)
    for (const userId of channelViewers(channelId)) {
      const sockets = clients.get(userId)
      if (!sockets) continue
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(data)
      }
    }
  }

  function voiceSnapshot() {
    const out = {}
    for (const [channelId, users] of voice) {
      out[channelId] = [...users.entries()].map(([userId, state]) => ({ userId, ...state }))
    }
    return out
  }

  function pushVoice(channelId) {
    broadcastAll({ op: 'voice_state', channelId, users: voiceSnapshot()[channelId] || [] })
  }

  function clearVoiceUser(userId) {
    for (const [channelId, users] of voice) {
      if (users.delete(userId)) pushVoice(channelId)
    }
  }

  function handleRtcEvent(event) {
    const name = event?.room?.name
    if (!name || !name.startsWith('ch-')) return
    const channelId = Number(name.slice(3))
    if (!Number.isFinite(channelId)) return
    const users = voice.get(channelId) || new Map()
    const identity = Number(event?.participant?.identity)
    // Uygulama yalnizca sayisal kullanici kimligi uretir; baska kaynakli
    // katilimcilari yok say (aksi halde NaN anahtariyla kayit acilir)
    if (event.event !== 'room_finished' && !Number.isFinite(identity)) return

    const ensure = (id) => {
      if (!users.has(id)) users.set(id, { muted: false, video: false, screen: false, joinedAt: Date.now() })
      return users.get(id)
    }

    switch (event.event) {
      case 'participant_joined':
        ensure(identity)
        break
      case 'participant_left':
        users.delete(identity)
        break
      case 'track_published':
      case 'track_unpublished': {
        if (!Number.isFinite(identity)) return
        const state = ensure(identity)
        const source = event?.track?.source
        const on = event.event === 'track_published'
        if (source === 'SCREEN_SHARE' || source === 'SCREEN_SHARE_AUDIO') state.screen = on
        else if (source === 'CAMERA') state.video = on
        else if (source === 'MICROPHONE') state.muted = !on
        break
      }
      case 'track_muted':
      case 'track_unmuted': {
        if (!Number.isFinite(identity)) return
        const state = ensure(identity)
        if (event?.track?.source === 'MICROPHONE') state.muted = event.event === 'track_muted'
        break
      }
      case 'room_finished':
        users.clear()
        draw.delete(channelId)
        break
      default:
        return
    }
    if (users.size) voice.set(channelId, users)
    else voice.delete(channelId)
    if (process.env.WEBHOOK_DEBUG === 'true') {
      console.log('VOICE_TRACE ' + JSON.stringify({
        ev: event.event,
        ch: channelId,
        id: identity,
        map: [...users.entries()].map(([k, v]) => ({ k, v }))
      }))
    }
    pushVoice(channelId)
  }

  function dropVoiceChannel(channelId) {
    if (voice.delete(channelId)) pushVoice(channelId)
    draw.delete(channelId)
  }

  function kickUser(userId) {
    const sockets = clients.get(userId)
    if (sockets) {
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify({ op: 'kicked' }))
          ws.close(4001, 'kicked')
        } catch {}
      }
    }
    clearVoiceUser(userId)
  }

  // --- Ortak çizim tahtası (oyun) ---
  // Her sesli kanalda en fazla 10 kişinin aynı tahtaya çizdiği oda.
  // Noktalar 0..1 aralığında normalleştirilir; herkes kendi ekran boyutunda
  // aynı çizimi görür. Renkler katılım sırasına göre paletten atanır.
  const draw = new Map() // channelId -> { strokes: [], users: Map<userId, { color, name }> }
  const DRAW_RENKLER = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#a855f7', '#0ea5e9']
  const DRAW_MAX = 10
  const DRAW_STROKE_LIMIT = 3000
  const DRAW_POINT_LIMIT = 500

  function drawRoom(channelId) {
    let room = draw.get(channelId)
    if (!room) {
      room = { strokes: [], users: new Map() }
      draw.set(channelId, room)
    }
    return room
  }

  function drawUsers(room) {
    return [...room.users.entries()].map(([userId, u]) => ({ userId, color: u.color, name: u.name }))
  }

  function sendDraw(channelId, message) {
    const room = draw.get(channelId)
    if (!room) return
    const data = JSON.stringify(message)
    for (const userId of room.users.keys()) {
      const sockets = clients.get(userId)
      if (!sockets) continue
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(data)
      }
    }
  }

  function leaveDraw(userId, channelId) {
    const room = draw.get(channelId)
    if (!room) return
    if (room.users.delete(userId)) {
      sendDraw(channelId, { op: 'draw_users', channelId, users: drawUsers(room) })
      if (!room.users.size) draw.delete(channelId)
    }
  }

  wss.on('connection', (ws, req) => {
    let user = sessionUser(tokenFromRequest(req))
    let authed = Boolean(user)
    let alive = true
    let currentChannel = null

    const finishAuth = (candidate) => {
      user = candidate
      authed = true
      const sockets = clients.get(user.id) || new Set()
      sockets.add(ws)
      clients.set(user.id, sockets)
      seen.set(user.id, Date.now())
      broadcastAll({ op: 'presence', userId: user.id, online: true })
      ws.send(JSON.stringify({ op: 'ready', userId: user.id, online: onlineIds() }))
    }

    if (authed) finishAuth(user)

    ws.on('pong', () => {
      alive = true
    })

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!authed) {
        if (msg.op === 'auth') {
          const candidate = sessionUser(msg.token)
          if (!candidate) return ws.close(4003, 'unauthorized')
          finishAuth(candidate)
        }
        return
      }
      seen.set(user.id, Date.now())
      const fresh = q.get('SELECT * FROM users WHERE id = ?', [user.id])
      if (!fresh || fresh.disabled) return ws.close(4001, 'disabled')
      user = fresh

      switch (msg.op) {
        case 'ping':
          ws.send(JSON.stringify({ op: 'pong', t: msg.t }))
          break
        case 'voice_join': {
          const channel = canSee(Number(msg.channelId), user.id)
          if (!channel || channel.type !== 'voice') return
          if (currentChannel && currentChannel !== channel.id) {
            const prev = voice.get(currentChannel)
            if (prev && prev.delete(user.id)) pushVoice(currentChannel)
            leaveDraw(user.id, currentChannel)
          }
          currentChannel = channel.id
          const users = voice.get(channel.id) || new Map()
          users.set(user.id, {
            muted: Boolean(msg.muted),
            video: Boolean(msg.video),
            screen: Boolean(msg.screen),
            joinedAt: Date.now()
          })
          voice.set(channel.id, users)
          pushVoice(channel.id)
          break
        }
        case 'voice_update': {
          const users = voice.get(Number(msg.channelId))
          if (!users || !users.has(user.id)) return
          const state = users.get(user.id)
          if (msg.muted !== undefined) state.muted = Boolean(msg.muted)
          if (msg.video !== undefined) state.video = Boolean(msg.video)
          if (msg.screen !== undefined) state.screen = Boolean(msg.screen)
          pushVoice(Number(msg.channelId))
          break
        }
        case 'voice_leave': {
          const channelId = Number(msg.channelId)
          const users = voice.get(channelId)
          if (users && users.delete(user.id)) pushVoice(channelId)
          if (currentChannel === channelId) currentChannel = null
          leaveDraw(user.id, channelId)
          break
        }
        case 'typing': {
          const channel = canSee(Number(msg.channelId), user.id)
          if (!channel) return
          const data = JSON.stringify({ op: 'typing', channelId: channel.id, userId: user.id, displayName: user.display_name })
          for (const viewer of channelViewers(channel.id)) {
            if (viewer === user.id) continue
            const sockets = clients.get(viewer)
            if (!sockets) continue
            for (const s of sockets) if (s.readyState === s.OPEN) s.send(data)
          }
          break
        }
        case 'draw_join': {
          const channel = canSee(Number(msg.channelId), user.id)
          if (!channel || channel.type !== 'voice') return
          if (!voice.get(channel.id)?.has(user.id)) return
          const room = drawRoom(channel.id)
          if (room.users.has(user.id)) return
          if (room.users.size >= DRAW_MAX) {
            ws.send(JSON.stringify({ op: 'draw_full', channelId: channel.id }))
            return
          }
          const used = new Set([...room.users.values()].map((u) => u.color))
          const color = DRAW_RENKLER.find((c) => !used.has(c)) || DRAW_RENKLER[room.users.size % DRAW_RENKLER.length]
          room.users.set(user.id, { color, name: user.display_name })
          ws.send(JSON.stringify({ op: 'draw_state', channelId: channel.id, strokes: room.strokes, users: drawUsers(room), me: color }))
          sendDraw(channel.id, { op: 'draw_users', channelId: channel.id, users: drawUsers(room) })
          break
        }
        case 'draw_leave': {
          leaveDraw(user.id, Number(msg.channelId))
          break
        }
        case 'draw_stroke': {
          const room = draw.get(Number(msg.channelId))
          if (!room || !room.users.has(user.id)) return
          const raw = Array.isArray(msg.stroke?.points) ? msg.stroke.points : []
          const points = raw
            .slice(0, DRAW_POINT_LIMIT)
            .map((p) => [Number(p?.[0]), Number(p?.[1])])
            .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1)
          if (!points.length) return
          const stroke = {
            id: typeof msg.stroke?.id === 'string' && msg.stroke.id ? msg.stroke.id : `${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            userId: user.id,
            color: typeof msg.stroke?.color === 'string' ? msg.stroke.color : '#3b82f6',
            width: Math.min(40, Math.max(1, Number(msg.stroke?.width) || 4)),
            eraser: Boolean(msg.stroke?.eraser),
            points
          }
          room.strokes.push(stroke)
          if (room.strokes.length > DRAW_STROKE_LIMIT) room.strokes.splice(0, room.strokes.length - DRAW_STROKE_LIMIT)
          sendDraw(Number(msg.channelId), { op: 'draw_stroke', channelId: Number(msg.channelId), stroke })
          break
        }
        case 'draw_undo': {
          const room = draw.get(Number(msg.channelId))
          if (!room || !room.users.has(user.id)) return
          const strokeId = typeof msg.strokeId === 'string' ? msg.strokeId : ''
          if (!strokeId) return
          const index = room.strokes.findIndex((s) => s.id === strokeId)
          // Yalnizca kendi vurusu geri alinabilir; baskasinin vurusuna dokunulmaz.
          if (index < 0 || room.strokes[index].userId !== user.id) return
          room.strokes.splice(index, 1)
          sendDraw(Number(msg.channelId), { op: 'draw_undo', channelId: Number(msg.channelId), strokeId })
          break
        }
        case 'draw_color': {
          const room = draw.get(Number(msg.channelId))
          if (!room || !room.users.has(user.id)) return
          const color = typeof msg.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(msg.color) ? msg.color : null
          if (!color) return
          room.users.get(user.id).color = color
          sendDraw(Number(msg.channelId), { op: 'draw_users', channelId: Number(msg.channelId), users: drawUsers(room) })
          break
        }
        case 'draw_clear': {
          const room = draw.get(Number(msg.channelId))
          if (!room || !room.users.has(user.id)) return
          room.strokes = []
          sendDraw(Number(msg.channelId), { op: 'draw_clear', channelId: Number(msg.channelId) })
          break
        }
        default:
          break
      }
    })

    ws.on('close', () => {
      const sockets = clients.get(user?.id)
      if (sockets) {
        sockets.delete(ws)
        if (!sockets.size) {
          clients.delete(user.id)
          broadcastAll({ op: 'presence', userId: user.id, online: false })
        }
      }
      if (currentChannel) {
        const users = voice.get(currentChannel)
        if (users && users.delete(user.id)) pushVoice(currentChannel)
        currentChannel = null
      }
      if (user) {
        for (const cid of [...draw.keys()]) {
          if (draw.get(cid)?.users.has(user.id)) leaveDraw(user.id, cid)
        }
        seen.set(user.id, Date.now())
      }
    })

    ws.on('error', () => {})
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue
      if (ws.__alive === false) {
        ws.terminate()
        continue
      }
      ws.__alive = false
      try {
        ws.ping()
      } catch {}
    }
  }, HEARTBEAT_MS)


  wss.on('connection', (ws) => {
    ws.__alive = true
    ws.on('pong', () => {
      ws.__alive = true
    })
  })

  function onlineIds() {
    return [...clients.keys()]
  }

  function lastSeen(userId) {
    return seen.get(userId) || null
  }

  function close() {
    clearInterval(heartbeat)
    for (const ws of wss.clients) ws.close(1001, 'shutdown')
    wss.close()
  }

  return {
    wss,
    broadcastAll,
    broadcastChannel,
    voiceSnapshot,
    handleRtcEvent,
    dropVoiceChannel,
    kickUser,
    onlineIds,
    lastSeen,
    close
  }
}
