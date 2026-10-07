// Local proxy bridge — an HTTP proxy server on 127.0.0.1 that forwards browser
// traffic to an upstream Webshare-style HTTP proxy (with auth). This is needed
// because Windows system proxy can't do per-account proxy authentication for
// browsers reliably: we spin a tiny local proxy that injects the credentials
// and chain: browser → 127.0.0.1:LOCAL_PORT → upstream proxy → target.
//
// Design:
//   - Listens on 127.0.0.1:{port} only (NEVER 0.0.0.0).
//   - Supports CONNECT (HTTPS) and absolute-URI GET/POST (HTTP forward).
//   - Injects Proxy-Authorization on every hop to the upstream.
//   - One bridge = one upstream proxy = one account.
//
// Exported:
//   startProxyBridge({ upstream, port, host, log }) -> { port, close() }
//   upstream: parseProxy() output or a parseable string.

import net from 'node:net'
import tls from 'node:tls'
import { parseProxy } from './proxy.mjs'

function safeLog(log, level, msg) { try { log && log(level, msg) } catch {} }

export function startProxyBridge({ upstream, port = 0, host = '127.0.0.1', log }) {
  const upstreamProxy = typeof upstream === 'string' ? parseProxy(upstream) : upstream
  if (!upstreamProxy || upstreamProxy.protocol !== 'http' || !upstreamProxy.authHeader) {
    throw new Error('startProxyBridge: upstream must be an HTTP proxy with auth')
  }

  const connections = new Set()
  let listeningPort = 0
  let closed = false

  const server = net.createServer((clientSocket) => {
    clientSocket.setTimeout(120_000)
    let buf = Buffer.alloc(0)
    let headParsed = false
    const cleanup = () => {
      clientSocket.removeAllListeners()
      try { clientSocket.destroy() } catch {}
      connections.delete(clientSocket)
    }
    connections.add(clientSocket)

    clientSocket.on('data', (chunk) => {
      if (headParsed) return // after bridge set, ignore further client data fwd
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) {
        if (buf.length > 8192) {
          clientSocket.write('HTTP/1.1 413 Request Entity Too Large\r\n\r\n')
          cleanup()
        }
        return
      }
      headParsed = true
      const head = buf.slice(0, idx).toString('latin1')
      const leftover = buf.slice(idx + 4)
      handleHead(head, leftover)
    })
    clientSocket.on('error', cleanup)
    clientSocket.on('close', cleanup)
    clientSocket.on('timeout', cleanup)

    function handleHead(headText, leftover) {
      const lines = headText.split('\r\n')
      const first = lines[0] || ''
      let target
      let isConnect = false
      if (first.startsWith('CONNECT ')) {
        isConnect = true
        target = first.slice('CONNECT '.length).split(/\s+/)[0]
      } else {
        // GET http://host/path HTTP/1.1
        target = first.split(/\s+/)[1]
      }

      // Forward any custom client headers EXCEPT hop-by-hop to upstream
      const forwarded = []
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        const ci = line.indexOf(':')
        if (ci === -1) continue
        const k = line.slice(0, ci).trim()
        const lower = k.toLowerCase()
        if (lower === 'proxy-authorization' || lower === 'proxy-connection' || lower === 'connection' || lower === 'keep-alive') continue
        forwarded.push(line)
      }

      // Connect to upstream proxy
      const upstreamSock = net.connect({ host: upstreamProxy.host, port: upstreamProxy.port })
      let upstreamBuf = Buffer.alloc(0)

      upstreamSock.on('error', (err) => {
        safeLog(log, 'warn', `[bridge] upstream error: ${err.message}`)
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch {}
        cleanup()
      })
      upstreamSock.on('close', cleanup)
      upstreamSock.on('timeout', cleanup)

      upstreamSock.on('connect', () => {
        if (isConnect) {
          // Send CONNECT to upstream with auth
          const reqLines = [
            `CONNECT ${target} HTTP/1.1`,
            `Host: ${target}`,
            `Proxy-Authorization: ${upstreamProxy.authHeader}`,
            'Proxy-Connection: keep-alive',
            '',
            '',
          ]
          upstreamSock.write(reqLines.join('\r\n'))
        } else {
          // Forward absolute-URI request line as-is, rewriting Host, adding auth
          const reqFirst = `${first.split(' ')[0]} ${target} HTTP/1.1`
          const reqLines = [reqFirst]
          let hostHeader = null
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i]
            const ci = line.indexOf(':')
            if (ci === -1) continue
            const k = line.slice(0, ci).trim()
            const lower = k.toLowerCase()
            if (lower === 'proxy-authorization' || lower === 'proxy-connection' || lower === 'connection' || lower === 'keep-alive') continue
            if (lower === 'host') { hostHeader = line; continue }
            reqLines.push(line)
          }
          try {
            const u = new URL(target)
            reqLines.unshift(`Host: ${u.host}`)
          } catch {}
          reqLines.push(`Proxy-Authorization: ${upstreamProxy.authHeader}`)
          reqLines.push('Proxy-Connection: keep-alive')
          reqLines.push('', '')
          upstreamSock.write(reqLines.join('\r\n'))
          if (leftover && leftover.length) upstreamSock.write(leftover)
        }
      })

      if (isConnect) {
        // Wait for upstream's "200 Connection established" then splice
        upstreamSock.on('data', (chunk) => {
          upstreamBuf = Buffer.concat([upstreamBuf, chunk])
          const ci = upstreamBuf.indexOf('\r\n\r\n')
          if (ci === -1) return
          const replyHead = upstreamBuf.slice(0, ci).toString('latin1')
          const statusLine = replyHead.split('\r\n')[0] || ''
          if (!/^HTTP\/1\.\d 200/i.test(statusLine)) {
            try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n') } catch {}
            cleanup()
            return
          }
          upstreamSock.removeAllListeners('data')
          // Tell browser we have a tunnel
          try { clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n') } catch {}
          // Any leftover bytes already read from upstream: forward to client
          if (upstreamBuf.length > ci + 4) clientSocket.write(upstreamBuf.slice(ci + 4))
          // Splice both directions
          clientSocket.on('data', (c) => upstreamSock.write(c))
          upstreamSock.on('data', (c) => clientSocket.write(c))
        })
        // CONNECT path doesn't consume the original `leftover` until splice
        // (per HTTP spec there shouldn't be any data after CONNECT's headers).
        if (leftover && leftover.length) upstreamSock.write(leftover)
      } else {
        // Direct splice after forwarding head
        upstreamSock.on('data', (c) => { try { clientSocket.write(c) } catch {} })
        clientSocket.on('data', (c) => upstreamSock.write(c))
      }
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      listeningPort = typeof addr === 'object' ? addr.port : port
      safeLog(log, 'info', `[bridge] local proxy on ${host}:${listeningPort} → upstream ${upstreamProxy.host}:${upstreamProxy.port}`)
      resolve({
        port: listeningPort,
        host,
        upstream: { host: upstreamProxy.host, port: upstreamProxy.port }, // host/port only, no creds
        close() {
          if (closed) return
          closed = true
          try { server.close() } catch {}
          for (const c of connections) { try { c.destroy() } catch {} }
          connections.clear()
          safeLog(log, 'info', `[bridge] closing ${host}:${listeningPort}`)
        },
      })
    })
  })
}