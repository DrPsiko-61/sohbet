import { createServer } from 'node:http'
import { buildRoutes, serveFile, cleanupOrphans, tokenFromRequest } from './http.js'
import { createHub } from './ws.js'
import { initMusicBot, kapatMusicBot } from './bot.js'
import { initSeed } from './seed.js'
import { purgeExpiredSessions } from './auth.js'
import { q } from './db.js'

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/healthz') {
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // YouTube gibi dis kaynaklar referrer gordugunde alan adina kisitli videolar
  // da oynayabiliyor; eski 'same-origin' degeri bunu engelliyordu.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  dispatch(req, res, url).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal_error' }))
    }
  })
})

const hub = createHub(server)
const routes = buildRoutes({ hub })
initSeed()
initMusicBot({ hub })

async function dispatch(req, res, url) {
  if (url.pathname.startsWith('/api/')) {
    for (const route of routes) {
      if (route.method !== req.method) continue
      const match = route.regex.exec(url.pathname)
      if (!match) continue
      const params = {}
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1])
      })
      return route.handler({ req, res, params, url })
    }
    const head = { 'Content-Type': 'application/json' }
    res.writeHead(404, head)
    return res.end(JSON.stringify({ error: 'not_found' }))
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, url.pathname)
  res.writeHead(405, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'method_not_allowed' }))
}

const maintenance = setInterval(() => {
  purgeExpiredSessions()
  q.insert('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()])
  cleanupOrphans()
}, 3600000)

server.listen(PORT, HOST, () => {
  console.log(`sohbet sunucusu ${HOST}:${PORT} uzerinde calisiyor`)
})

function shutdown() {
  clearInterval(maintenance)
  kapatMusicBot()
  hub.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 4000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
