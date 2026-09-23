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

  // --- Satranç ---
  // Her sesli kanalda 2 kisilik satranc odasi. Hamleler sunucuda dogrulanir.
  const satranc = new Map() // channelId -> room
  // room: { players: Map<userId,'w'|'b'>, board, turn, castling, ep, state, winner, lastMove }

  function satrancRoom(channelId) {
    let room = satranc.get(channelId)
    if (!room) {
      room = { players: new Map(), board: satrancBaslangic(), turn: 'w', castling: { wk: true, wq: true, bk: true, bq: true }, ep: null, state: 'bekliyor', winner: null, lastMove: null }
      satranc.set(channelId, room)
    }
    return room
  }

  function satrancBaslangic() {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null))
    const arka = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
    for (let i = 0; i < 8; i++) {
      b[0][i] = { t: arka[i], c: 'b' }
      b[1][i] = { t: 'p', c: 'b' }
      b[6][i] = { t: 'p', c: 'w' }
      b[7][i] = { t: arka[i], c: 'w' }
    }
    return b
  }

  function satrancKareSaldiri(board, r, c, byColor) {
    const inBoard = (rr, cc) => rr >= 0 && rr < 8 && cc >= 0 && cc < 8
    const at = (rr, cc) => (inBoard(rr, cc) ? board[rr][cc] : null)
    const p = (rr, cc, t) => { const x = at(rr, cc); return x && x.c === byColor && x.t === t }
    const dir = byColor === 'w' ? -1 : 1
    if (p(r - dir, c - 1, 'p') || p(r - dir, c + 1, 'p')) return true
    for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) if (p(r + dr, c + dc, 'n')) return true
    for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) if (p(r + dr, c + dc, 'k')) return true
    for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
      let rr = r + dr, cc = c + dc
      while (inBoard(rr, cc)) {
        const x = at(rr, cc)
        if (x) {
          if (x.c === byColor && (x.t === 'q' || (x.t === 'b' && dr !== 0 && dc !== 0) || (x.t === 'r' && (dr === 0 || dc === 0)))) return true
          break
        }
        rr += dr; cc += dc
      }
    }
    return false
  }

  function satrancSah(board, color) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (board[r][c]?.t === 'k' && board[r][c]?.c === color) return satrancKareSaldiri(board, r, c, color === 'w' ? 'b' : 'w')
    }
    return true
  }

  function satrancUygula(board, m) {
    const [fr, fc] = m.from, [tr, tc] = m.to
    const piece = board[fr][fc]
    board[fr][fc] = null
    if (m.ep) board[fr][tc] = null
    board[tr][tc] = m.promo ? { t: m.promo, c: piece.c } : piece
    if (m.castle === 'k') { board[fr][7] = null; board[fr][5] = { t: 'r', c: piece.c } }
    if (m.castle === 'q') { board[fr][0] = null; board[fr][3] = { t: 'r', c: piece.c } }
  }

  function satrancHamleler(board, color, castling, ep) {
    const inBoard = (rr, cc) => rr >= 0 && rr < 8 && cc >= 0 && cc < 8
    const at = (rr, cc) => (inBoard(rr, cc) ? board[rr][cc] : null)
    const moves = []
    const push = (fr, fc, tr, tc, extra) => { if (inBoard(tr, tc)) moves.push({ from: [fr, fc], to: [tr, tc], ...extra }) }
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c]
      if (!p || p.c !== color) continue
      const t = p.t
      if (t === 'p') {
        const dir = color === 'w' ? -1 : 1
        const start = color === 'w' ? 6 : 1
        const promo = r + dir === 0 || r + dir === 7 ? 'q' : null
        if (inBoard(r + dir, c) && !at(r + dir, c)) {
          push(r, c, r + dir, c, { promo })
          if (r === start && !at(r + 2 * dir, c)) push(r, c, r + 2 * dir, c, {})
        }
        for (const dc of [-1, 1]) {
          const nc = c + dc
          if (!inBoard(r + dir, nc)) continue
          const target = at(r + dir, nc)
          if (target && target.c !== color) push(r, c, r + dir, nc, { promo })
          else if (ep && ep[0] === r + dir && ep[1] === nc) push(r, c, r + dir, nc, { ep: true })
        }
      } else if (t === 'n') {
        for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
          const nr = r + dr, nc = c + dc
          const target = at(nr, nc)
          if (inBoard(nr, nc) && (!target || target.c !== color)) push(r, c, nr, nc, {})
        }
      } else if (t === 'b' || t === 'r' || t === 'q') {
        const yonler = t === 'b' ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] : t === 'r' ? [[-1, 0], [1, 0], [0, -1], [0, 1]] : [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
        for (const [dr, dc] of yonler) {
          let nr = r + dr, nc = c + dc
          while (inBoard(nr, nc)) {
            const target = at(nr, nc)
            if (!target) push(r, c, nr, nc, {})
            else { if (target.c !== color) push(r, c, nr, nc, {}); break }
            nr += dr; nc += dc
          }
        }
      } else if (t === 'k') {
        for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
          const nr = r + dr, nc = c + dc
          const target = at(nr, nc)
          if (inBoard(nr, nc) && (!target || target.c !== color)) push(r, c, nr, nc, {})
        }
        const opp = color === 'w' ? 'b' : 'w'
        if (color === 'w' && r === 7 && c === 4) {
          if (castling.wk && !at(7, 5) && !at(7, 6) && at(7, 7)?.t === 'r' && at(7, 7)?.c === 'w' && !satrancKareSaldiri(board, 7, 5, opp) && !satrancKareSaldiri(board, 7, 6, opp)) push(7, 4, 7, 6, { castle: 'k' })
          if (castling.wq && !at(7, 3) && !at(7, 2) && !at(7, 1) && at(7, 0)?.t === 'r' && at(7, 0)?.c === 'w' && !satrancKareSaldiri(board, 7, 3, opp) && !satrancKareSaldiri(board, 7, 2, opp)) push(7, 4, 7, 2, { castle: 'q' })
        }
        if (color === 'b' && r === 0 && c === 4) {
          if (castling.bk && !at(0, 5) && !at(0, 6) && at(0, 7)?.t === 'r' && at(0, 7)?.c === 'b' && !satrancKareSaldiri(board, 0, 5, opp) && !satrancKareSaldiri(board, 0, 6, opp)) push(0, 4, 0, 6, { castle: 'k' })
          if (castling.bq && !at(0, 3) && !at(0, 2) && !at(0, 1) && at(0, 0)?.t === 'r' && at(0, 0)?.c === 'b' && !satrancKareSaldiri(board, 0, 3, opp) && !satrancKareSaldiri(board, 0, 2, opp)) push(0, 4, 0, 2, { castle: 'q' })
        }
      }
    }
    return moves.filter((m) => {
      const nb = board.map((row) => row.slice())
      satrancUygula(nb, m)
      return !satrancSah(nb, color)
    })
  }

  function satrancDurum(room) {
    return {
      players: [...room.players.entries()].map(([userId, renk]) => ({ userId, renk })),
      board: room.board,
      turn: room.turn,
      castling: room.castling,
      ep: room.ep,
      state: room.state,
      winner: room.winner,
      lastMove: room.lastMove
    }
  }

  function sendSatranc(channelId, message) {
    const room = satranc.get(channelId)
    if (!room) return
    const data = JSON.stringify(message)
    for (const userId of room.players.keys()) {
      const sockets = clients.get(userId)
      if (!sockets) continue
      for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  function satrancSifirla(room) {
    room.board = satrancBaslangic()
    room.turn = 'w'
    room.castling = { wk: true, wq: true, bk: true, bq: true }
    room.ep = null
    room.state = 'oyun'
    room.winner = null
    room.lastMove = null
  }

  // --- Okey (duz okey) ---
  // 106 tas: 4 renk x 2 deste x 1-13 + 2 sahte okey. 4 kisi, 14 tas (ilk oyuncu 15).
  // Gosterge belirlenir, okey tasi sahte okeylerle birlikte joker olur.
  const okey = new Map() // channelId -> room
  const OKEY_RENKLER = ['k', 's', 'm', 'a'] // kirmizi, sari, mavi, siyah
  const OKEY_RENK_AD = { k: 'kırmızı', s: 'sarı', m: 'mavi', a: 'siyah' }
  const OKEY_HEDEF = 3 // 3 el kazanan oyunu kazanir

  function okeyRoom(channelId) {
    let room = okey.get(channelId)
    if (!room) {
      room = { players: new Map(), hands: new Map(), wall: [], discard: [], gosterge: null, okey: null, turn: null, cekti: new Map(), state: 'bekliyor', kazanan: null, roundWins: new Map(), first: null, sonAtilan: null }
      okey.set(channelId, room)
    }
    return room
  }

  function okeyOkey(gosterge) {
    if (gosterge === 'j1' || gosterge === 'j2') return 'j1'
    const renk = gosterge[0]
    const num = Number(gosterge.slice(1))
    return renk + (num === 13 ? 1 : num + 1)
  }

  function okeyDagit(room) {
    const taslar = []
    for (const renk of OKEY_RENKLER) for (let n = 1; n <= 13; n++) { taslar.push(renk + n); taslar.push(renk + n) }
    taslar.push('j1', 'j2')
    for (let i = taslar.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[taslar[i], taslar[j]] = [taslar[j], taslar[i]]
    }
    const ids = [...room.players.keys()]
    const first = ids[Math.floor(Math.random() * ids.length)]
    room.first = first
    room.hands = new Map()
    room.cekti = new Map()
    let idx = 0
    for (const id of ids) {
      const n = id === first ? 15 : 14
      room.hands.set(id, taslar.slice(idx, idx + n))
      room.cekti.set(id, id === first)
      idx += n
    }
    room.wall = taslar.slice(idx)
    room.discard = []
    room.sonAtilan = null
    room.gosterge = room.wall.pop()
    room.okey = okeyOkey(room.gosterge)
    room.turn = first
    room.state = 'oyun'
    room.kazanan = null
  }

  function okeySira(room, userId) {
    const ids = [...room.players.keys()]
    const i = ids.indexOf(userId)
    return ids[(i + 1) % ids.length]
  }

  function okeyElAcikMi(hand, okeyTas) {
    const say = new Map()
    for (const t of hand) say.set(t, (say.get(t) || 0) + 1)
    let wild = 0
    for (const t of ['j1', 'j2']) { wild += say.get(t) || 0; say.delete(t) }
    if (okeyTas !== 'j1' && okeyTas !== 'j2') { wild += say.get(okeyTas) || 0; say.delete(okeyTas) }
    const icIce = new Map()
    for (const [t, n] of say) {
      const renk = t[0]
      const num = Number(t.slice(1))
      if (!icIce.has(renk)) icIce.set(renk, new Map())
      icIce.get(renk).set(num, n)
    }
    const klon = () => {
      const y = new Map()
      for (const [r, nums] of icIce) y.set(r, new Map(nums))
      return y
    }
    const azalt = (m, r, n) => {
      const nums = m.get(r)
      const k = nums.get(n)
      if (k === 1) nums.delete(n)
      else nums.set(n, k - 1)
      if (!nums.size) m.delete(r)
    }
    // Cift: iki ayni tas
    for (const [t, n] of say) {
      if (n < 2) continue
      const y = klon()
      azalt(y, t[0], Number(t.slice(1)))
      azalt(y, t[0], Number(t.slice(1)))
      if (okeyGrupKontrol(y, wild)) return true
    }
    // Cift: tas + joker
    if (wild >= 1) {
      for (const t of say.keys()) {
        const y = klon()
        azalt(y, t[0], Number(t.slice(1)))
        if (okeyGrupKontrol(y, wild - 1)) return true
      }
    }
    // Cift: iki joker
    if (wild >= 2 && okeyGrupKontrol(klon(), wild - 2)) return true
    return false
  }

  function okeyGrupKontrol(say, wild) {
    if (!say.size) return wild === 0
    let ilk = null
    for (const [r, nums] of say) for (const [n, cnt] of nums) if (cnt > 0) { ilk = [r, Number(n)]; break }
    if (!ilk) return wild === 0
    const [renk, num] = ilk
    const azalt = (r, n) => {
      const m = say.get(r)
      const k = m.get(n)
      if (k === 1) m.delete(n)
      else m.set(n, k - 1)
      if (!m.size) say.delete(r)
    }
    const klon = () => {
      const y = new Map()
      for (const [r, nums] of say) y.set(r, new Map(nums))
      return y
    }
    // SET: ayni numara, farkli renkler (3-4 tas)
    const renkler = []
    for (const [r, nums] of say) if ((nums.get(num) || 0) > 0) renkler.push(r)
    for (let boyut = 3; boyut <= 4; boyut++) {
      const eksik = boyut - renkler.length
      if (eksik >= 0 && eksik <= wild) {
        const yedek = klon()
        for (const r of renkler.slice(0, boyut)) azalt(r, num)
        if (okeyGrupKontrol(say, wild - eksik)) return true
        say.clear()
        for (const [r, nums] of yedek) say.set(r, new Map(nums))
      }
    }
    // RUN: ayni renk, ardisik numaralar (3+ tas)
    let uzunluk = 0
    while ((say.get(renk)?.get(num + uzunluk) || 0) > 0) uzunluk++
    for (let boyut = 3; boyut <= 13; boyut++) {
      const eksik = boyut - uzunluk
      if (eksik >= 0 && eksik <= wild && num + boyut - 1 <= 13) {
        const yedek = klon()
        for (let i = 0; i < uzunluk; i++) azalt(renk, num + i)
        if (okeyGrupKontrol(say, wild - eksik)) return true
        say.clear()
        for (const [r, nums] of yedek) say.set(r, new Map(nums))
      }
    }
    return false
  }

  function okeyTasDeger(tas, okeyTas) {
    if (tas === 'j1' || tas === 'j2') return 2
    const num = Number(tas.slice(1))
    return tas === okeyTas ? num * 2 : num
  }

  function okeyDurum(room, userId) {
    return {
      players: [...room.players.entries()].map(([id, u]) => ({ userId: id, name: u.name, tasSayisi: room.hands.get(id)?.length || 0, roundWins: room.roundWins.get(id) || 0 })),
      el: room.hands.get(userId) || [],
      wallCount: room.wall.length,
      discard: room.discard,
      sonAtilan: room.sonAtilan,
      gosterge: room.gosterge,
      okey: room.okey,
      turn: room.turn,
      cekti: room.cekti.get(userId) || false,
      state: room.state,
      kazanan: room.kazanan,
      first: room.first,
      ben: userId
    }
  }

  function sendOkey(channelId, message) {
    const room = okey.get(channelId)
    if (!room) return
    for (const userId of room.players.keys()) {
      const sockets = clients.get(userId)
      if (!sockets) continue
      const data = JSON.stringify({ ...message, durum: okeyDurum(room, userId) })
      for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data)
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
        case 'satranc_join': {
          const channel = canSee(Number(msg.channelId), user.id)
          if (!channel || channel.type !== 'voice') return
          if (!voice.get(channel.id)?.has(user.id)) return
          const room = satrancRoom(channel.id)
          if (room.players.has(user.id)) break
          if (room.players.size >= 2) {
            ws.send(JSON.stringify({ op: 'satranc_dolu', channelId: channel.id }))
            break
          }
          const renk = room.players.size === 0 ? 'w' : 'b'
          room.players.set(user.id, renk)
          sendSatranc(channel.id, { op: 'satranc_state', channelId: channel.id, durum: satrancDurum(room) })
          break
        }
        case 'satranc_leave': {
          const room = satranc.get(Number(msg.channelId))
          if (!room) break
          if (room.players.delete(user.id)) {
            sendSatranc(Number(msg.channelId), { op: 'satranc_state', channelId: Number(msg.channelId), durum: satrancDurum(room) })
            if (!room.players.size) satranc.delete(Number(msg.channelId))
          }
          break
        }
        case 'satranc_basla': {
          const room = satranc.get(Number(msg.channelId))
          if (!room || room.players.size !== 2) break
          satrancSifirla(room)
          sendSatranc(Number(msg.channelId), { op: 'satranc_state', channelId: Number(msg.channelId), durum: satrancDurum(room) })
          break
        }
        case 'satranc_move': {
          const room = satranc.get(Number(msg.channelId))
          if (!room || room.state !== 'oyun') break
          const renk = room.players.get(user.id)
          if (!renk || renk !== room.turn) break
          const from = msg.from, to = msg.to
          if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 2 || to.length !== 2) break
          const hamleler = satrancHamleler(room.board, room.turn, room.castling, room.ep)
          const hamle = hamleler.find((h) => h.from[0] === from[0] && h.from[1] === from[1] && h.to[0] === to[0] && h.to[1] === to[1])
          if (!hamle) break
          const tas = room.board[from[0]][from[1]]
          satrancUygula(room.board, hamle)
          // Rok haklari
          if (tas.t === 'k') {
            if (renk === 'w') { room.castling.wk = false; room.castling.wq = false }
            else { room.castling.bk = false; room.castling.bq = false }
          }
          if (tas.t === 'r') {
            if (renk === 'w' && from[0] === 7 && from[1] === 0) room.castling.wq = false
            if (renk === 'w' && from[0] === 7 && from[1] === 7) room.castling.wk = false
            if (renk === 'b' && from[0] === 0 && from[1] === 0) room.castling.bq = false
            if (renk === 'b' && from[0] === 0 && from[1] === 7) room.castling.bk = false
          }
          // Gecerek alma karesi
          room.ep = null
          if (tas.t === 'p' && Math.abs(to[0] - from[0]) === 2) room.ep = [(from[0] + to[0]) / 2, from[1]]
          room.lastMove = { from, to, castle: hamle.castle || null, ep: hamle.ep || false, promo: hamle.promo || null }
          room.turn = room.turn === 'w' ? 'b' : 'w'
          const rakipHamleler = satrancHamleler(room.board, room.turn, room.castling, room.ep)
          if (!rakipHamleler.length) {
            if (satrancSah(room.board, room.turn)) {
              room.state = 'mat'
              room.winner = renk
            } else {
              room.state = 'pat'
              room.winner = null
            }
          }
          sendSatranc(Number(msg.channelId), { op: 'satranc_state', channelId: Number(msg.channelId), durum: satrancDurum(room) })
          break
        }
        case 'okey_join': {
          const channel = canSee(Number(msg.channelId), user.id)
          if (!channel || channel.type !== 'voice') return
          if (!voice.get(channel.id)?.has(user.id)) return
          const room = okeyRoom(channel.id)
          if (room.players.has(user.id)) break
          if (room.players.size >= 4) {
            ws.send(JSON.stringify({ op: 'okey_dolu', channelId: channel.id }))
            break
          }
          room.players.set(user.id, { name: user.display_name })
          room.roundWins.set(user.id, room.roundWins.get(user.id) || 0)
          sendOkey(channel.id, { op: 'okey_state', channelId: channel.id })
          break
        }
        case 'okey_leave': {
          const room = okey.get(Number(msg.channelId))
          if (!room) break
          if (room.players.delete(user.id)) {
            room.roundWins.delete(user.id)
            if (room.state === 'oyun' && room.players.size < 2) {
              room.state = 'bekliyor'
              room.kazanan = null
            }
            sendOkey(Number(msg.channelId), { op: 'okey_state', channelId: Number(msg.channelId) })
            if (!room.players.size) okey.delete(Number(msg.channelId))
          }
          break
        }
        case 'okey_basla': {
          const room = okey.get(Number(msg.channelId))
          if (!room || room.players.size < 2 || room.players.size > 4) break
          okeyDagit(room)
          sendOkey(Number(msg.channelId), { op: 'okey_state', channelId: Number(msg.channelId) })
          break
        }
        case 'okey_cekim': {
          const room = okey.get(Number(msg.channelId))
          if (!room || room.state !== 'oyun' || room.turn !== user.id || room.cekti.get(user.id)) break
          const kaynak = msg.kaynak === 'cope' ? 'cope' : 'duvar'
          let tas = null
          if (kaynak === 'cope' && room.discard.length) tas = room.discard.pop()
          else if (room.wall.length) tas = room.wall.pop()
          if (!tas) break
          room.hands.get(user.id).push(tas)
          room.cekti.set(user.id, true)
          room.sonAtilan = null
          sendOkey(Number(msg.channelId), { op: 'okey_state', channelId: Number(msg.channelId) })
          break
        }
        case 'okey_at': {
          const room = okey.get(Number(msg.channelId))
          if (!room || room.state !== 'oyun' || room.turn !== user.id || !room.cekti.get(user.id)) break
          const tas = typeof msg.tas === 'string' ? msg.tas : ''
          const el = room.hands.get(user.id)
          const i = el.indexOf(tas)
          if (i < 0) break
          el.splice(i, 1)
          room.discard.push(tas)
          room.sonAtilan = tas
          room.cekti.set(user.id, false)
          room.turn = okeySira(room, user.id)
          sendOkey(Number(msg.channelId), { op: 'okey_state', channelId: Number(msg.channelId) })
          break
        }
        case 'okey_elac': {
          const room = okey.get(Number(msg.channelId))
          if (!room || room.state !== 'oyun' || room.turn !== user.id) break
          const el = room.hands.get(user.id)
          if (!okeyElAcikMi(el, room.okey)) break
          room.state = 'bitti'
          room.kazanan = user.id
          const puan = {}
          for (const [id, u] of room.players) {
            if (id === user.id) continue
            const toplam = (room.hands.get(id) || []).reduce((s, t) => s + okeyTasDeger(t, room.okey), 0)
            puan[id] = toplam
          }
          room.roundWins.set(user.id, (room.roundWins.get(user.id) || 0) + 1)
          sendOkey(Number(msg.channelId), { op: 'okey_state', channelId: Number(msg.channelId), kazanan: user.id, puan })
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
        for (const cid of [...satranc.keys()]) {
          const room = satranc.get(cid)
          if (room?.players.has(user.id)) {
            room.players.delete(user.id)
            sendSatranc(cid, { op: 'satranc_state', channelId: cid, durum: satrancDurum(room) })
            if (!room.players.size) satranc.delete(cid)
          }
        }
        for (const cid of [...okey.keys()]) {
          const room = okey.get(cid)
          if (room?.players.has(user.id)) {
            room.players.delete(user.id)
            room.roundWins.delete(user.id)
            if (room.state === 'oyun' && room.players.size < 2) {
              room.state = 'bekliyor'
              room.kazanan = null
            }
            sendOkey(cid, { op: 'okey_state', channelId: cid })
            if (!room.players.size) okey.delete(cid)
          }
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
