import { PassThrough } from 'node:stream'
// Per-account HTTP/HTTPS proxy client - zero external dependencies.
//
// Supports proxy formats:
//   http://user:pass@ip:port
//   ip:port:user:pass
//   ip:port           (no auth)
//   http://ip:port
//   socks5://user:pass@ip:port    (best-effort: SOCKS5 CONNECT for HTTPS only)
//
// Implementation: native node:net + node:tls. For HTTPS targets we send
// "CONNECT host:443 HTTP/1.1" to the proxy, wait for "200 Connection established",
// then upgrade the socket to TLS. For HTTP targets we issue a proxied GET/POST
// with an absolute-URI request line (forward proxy).
//
// Exported:
//   parseProxy(str) -> {host, port, auth, protocol, authHeader} | null
//   proxiedFetch(url, { headers, body, proxy, signal }) -> fetch-like response
//
// Never logs proxy credentials.

import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'

//  Parsing 

/**
 * Parse a proxy string in any supported format.
 * Returns { host, port, auth, protocol, authHeader } or null if invalid.
 *   - protocol: 'http' or 'socks5'
 *   - auth: { username, password } | null
 *   - authHeader: 'Basic abc==' | null  (for HTTP Proxy-Authorization)
 */
export function parseProxy(str) {
  if (!str || typeof str !== 'string') return null
  const raw = str.trim()
  if (!raw) return null

  // socks5://...
  const socks = raw.match(/^socks5?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:]+):(\d+)$/i)
  if (socks) {
    return {
      protocol: 'socks5',
      host: socks[3],
      port: parseInt(socks[4], 10),
      auth: socks[1] ? { username: decodeURIComponent(socks[1]), password: socks[2] ? decodeURIComponent(socks[2]) : '' } : null,
      authHeader: null,
    }
  }

  // http://[user:pass@]host:port
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      const username = decodeURIComponent(u.username || '')
      const password = decodeURIComponent(u.password || '')
      const auth = username || password ? { username, password } : null
      return {
        protocol: 'http',
        host: u.hostname,
        port: parseInt(u.port || '80', 10),
        auth,
        authHeader: auth ? 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64') : null,
      }
    } catch {
      return null
    }
  }

  // ip:port:user:pass  OR  ip:port
  const parts = raw.split(':')
  if (parts.length === 4) {
    const [host, portRaw, username, password] = parts
    const port = parseInt(portRaw, 10)
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    const auth = { username, password }
    return { protocol: 'http', host, port, auth, authHeader: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }
  }
  if (parts.length === 2) {
    const [host, portRaw] = parts
    const port = parseInt(portRaw, 10)
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { protocol: 'http', host, port, auth: null, authHeader: null }
  }

  return null
}

/** Mask a proxy string for safe logging: hides user:pass, shows only host:port + protocol. */
export function maskProxy(str) {
  const p = typeof str === 'string' ? parseProxy(str) : str
  if (!p) return '(invalid)'
  return `${p.protocol}://${p.host}:${p.port}`
}

//  HTTP CONNECT tunnel (HTTPS upstream) 

function connectThroughHttpProxy({ proxy, targetHost, targetPort, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let settled = false
    let buffer = ''

    const cleanup = (err) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      if (err) reject(err)
    }

    const onAbort = () => cleanup(new Error('aborted'))
    if (signal) {
      if (signal.aborted) return cleanup(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const failTimer = setTimeout(() => cleanup(new Error(`proxy CONNECT timeout (${proxy.host}:${proxy.port})`)), timeoutMs)

    socket.once('connect', () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Proxy-Connection: keep-alive',
      ]
      if (proxy.authHeader) lines.push(`Proxy-Authorization: ${proxy.authHeader}`)
      lines.push('', '')
      socket.write(lines.join('\r\n'))
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx === -1) return
      clearTimeout(failTimer)
      if (signal) signal.removeEventListener('abort', onAbort)

      const head = buffer.slice(0, idx)
      const statusLine = head.split('\r\n')[0] || ''
      const m = statusLine.match(/^HTTP\/1\.\d (\d{3})(?:\s+(.*))?$/i)
      socket.removeAllListeners()

      if (!m || m[1] !== '200') {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed: ${statusLine}`))
        return
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
      }, () => {
        if (settled) { tlsSocket.destroy(); return }
        settled = true
        clearTimeout(failTimer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(tlsSocket)
      })
      tlsSocket.once('error', (err) => {
        if (!settled) cleanup(err)
      })
    })

    socket.once('error', cleanup)
    socket.once('close', () => {
      if (!settled) cleanup(new Error('proxy socket closed before CONNECT response'))
    })
  })
}

//  SOCKS5 CONNECT (HTTPS upstream) 

function socks5Connect({ proxy, targetHost, targetPort, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let settled = false

    const cleanup = (err) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      if (err) reject(err)
    }
    const onAbort = () => cleanup(new Error('aborted'))
    if (signal) {
      if (signal.aborted) return cleanup(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const failTimer = setTimeout(() => cleanup(new Error(`socks5 timeout (${proxy.host}:${proxy.port})`)), timeoutMs)

    function ipToBytes(host) {
      const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (m) {
        return { atyp: 0x01, buf: Buffer.from([+m[1], +m[2], +m[3], +m[4]]) }
      }
      const b = Buffer.from(host, 'utf8')
      return { atyp: 0x03, buf: Buffer.concat([Buffer.from([b.length]), b]) }
    }

    socket.once('connect', () => {
      if (proxy.auth) socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]))
      else socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })

    const handlers = [
      (chunk) => {
        if (chunk[0] !== 0x05) throw new Error('bad SOCKS5 version')
        const method = chunk[1]
        if (method === 0x02 && proxy.auth) {
          const u = Buffer.from(proxy.auth.username, 'utf8')
          const p = Buffer.from(proxy.auth.password, 'utf8')
          socket.write(Buffer.concat([
            Buffer.from([0x01, u.length]), u,
            Buffer.from([p.length]), p,
          ]))
          return 2
        }
        if (method === 0x00) return requestConnect()
        throw new Error('SOCKS5 method not supported: ' + method)
      },
      (chunk) => {
        if (chunk[0] !== 0x01) throw new Error('bad SOCKS5 auth version')
        if (chunk[1] !== 0x00) throw new Error('SOCKS5 auth failed')
        requestConnect()
        return null
      },
    ]

    function requestConnect() {
      const { atyp, buf } = ipToBytes(targetHost)
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(targetPort)
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), buf, portBuf]))
      current = connectReply
    }

    function connectReply(chunk) {
      if (chunk[0] !== 0x05) throw new Error('bad SOCKS5 version in CONNECT reply')
      if (chunk[1] !== 0x00) throw new Error('SOCKS5 CONNECT failed: ' + chunk[1])
      clearTimeout(failTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
        if (settled) { tlsSocket.destroy(); return }
        settled = true
        resolve(tlsSocket)
      })
      tlsSocket.once('error', (err) => { if (!settled) cleanup(err) })
    }

    let current = handlers[0]
    socket.on('data', (chunk) => {
      try {
        const next = current(chunk)
        if (next === 2) current = handlers[1]
      } catch (err) {
        cleanup(err)
      }
    })
    socket.once('error', cleanup)
    socket.once('close', () => { if (!settled) cleanup(new Error('socks5 socket closed')) })
  })
}

//  Low-level HTTP/1.1 over a (plain or TLS) socket 

function sendHttpRequest(socket, { method, target, headers, body, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => { if (!settled) { settled = true; socket.destroy(); reject(new Error('aborted')) } }
    if (signal) {
      if (signal.aborted) return reject(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const failTimer = setTimeout(() => {
      if (!settled) { settled = true; socket.destroy(); reject(new Error(`request timeout (${target})`)) }
    }, timeoutMs)

    const lines = [`${method} ${target} HTTP/1.1`]
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
    lines.push('', '')
    socket.write(lines.join('\r\n'))
    if (body) socket.write(body)

    let headBuf = ''
    let headersDone = false
    let statusCode = 0
    let respHeaders = {}
    let bodyChunks = []
    let bodyStream = null
    let contentLength = -1
    let isChunked = false

    function setupBodyParser() {
      const te = (respHeaders['transfer-encoding'] || '').toLowerCase()
      isChunked = te.includes('chunked')
      const cl = respHeaders['content-length']
      if (cl != null && /^\d+$/.test(String(cl))) contentLength = parseInt(String(cl), 10)
    }

    function emitBodyChunk(buf) {
      if (bodyStream) bodyStream.push(buf)
      else bodyChunks.push(buf)
    }

    function finishBody() {
      clearTimeout(failTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (bodyStream) bodyStream.push(null)
    }

    socket.on('data', (chunk) => {
      if (!headersDone) {
        headBuf += chunk.toString('latin1')
        const idx = headBuf.indexOf('\r\n\r\n')
        if (idx === -1) return

        const headText = headBuf.slice(0, idx)
        const remaining = Buffer.from(headBuf.slice(idx + 4), 'latin1')
        headBuf = ''

        const linesArr = headText.split('\r\n')
        const statusLine = linesArr[0] || ''
        const m = statusLine.match(/^HTTP\/1\.\d (\d{3})(?:\s+(.*))?$/i)
        if (!m) {
          settled = true
          socket.destroy()
          reject(new Error('bad HTTP response status line: ' + statusLine))
          return
        }
        statusCode = parseInt(m[1], 10)
        for (let i = 1; i < linesArr.length; i++) {
          const line = linesArr[i]
          const ci = line.indexOf(':')
          if (ci === -1) continue
          const k = line.slice(0, ci).trim().toLowerCase()
          const v = line.slice(ci + 1).trim()
          if (k in respHeaders) respHeaders[k] += ', ' + v
          else respHeaders[k] = v
        }
        setupBodyParser()
        headersDone = true

        settled = true
        
        bodyStream = new PassThrough()
        resolve({
          status: statusCode,
          statusText: m[2] || '',
          headers: makeHeadersApi(respHeaders),
          body: bodyStream,
          rawHeaders: respHeaders,
        })

        if (remaining.length) consumeBody(remaining)
      } else {
        consumeBody(chunk)
      }
    })

    function consumeBody(buf) {
      if (!isChunked) {
        emitBodyChunk(buf)
        return
      }
      if (!consumeBody._pending) consumeBody._pending = Buffer.alloc(0)
      consumeBody._pending = Buffer.concat([consumeBody._pending, buf])
      const out = consumeBody._pending
      let i = 0
      let consumed = 0
      let parts = []
      while (true) {
        const nl = out.indexOf('\r\n', i)
        if (nl === -1) break
        const sizeStr = out.slice(i, nl).toString('latin1').trim()
        const semi = sizeStr.indexOf(';')
        const size = parseInt(semi === -1 ? sizeStr : sizeStr.slice(0, semi), 16)
        if (Number.isNaN(size)) break
        if (size === 0) {
          consumed = out.length
          break
        }
        const start = nl + 2
        const end = start + size
        if (out.length < end + 2) break
        parts.push(out.slice(start, end))
        i = end + 2
        consumed = i
      }
      if (parts.length) emitBodyChunk(Buffer.concat(parts))
      consumeBody._pending = out.slice(consumed)
    }

    socket.once('end', () => {
      if (!settled) {
        clearTimeout(failTimer)
        settled = true
        reject(new Error('connection ended before headers'))
        return
      }
      finishBody()
    })
    socket.once('error', (err) => {
      clearTimeout(failTimer)
      if (!settled) { settled = true; reject(err) }
      else { if (bodyStream) bodyStream.destroy(err) }
    })
    socket.once('close', () => {
      if (settled) finishBody()
    })
  })
}

function makeHeadersApi(raw) {
  return {
    raw,
    get(name) { return raw[(name || '').toLowerCase()] ?? null },
    has(name) { return ((name || '').toLowerCase()) in raw },
  }
}

//  Public: proxiedFetch 

/**
 * fetch-like request through a proxy. If `proxy` is null/invalid, falls back
 * to native global fetch.
 *
 * Returns: { status, headers, body: ReadableStream, text(), async arrayBuffer() }
 *
 * Notes:
 *   - Only HTTPS targets are tunnelled via CONNECT (the common case for Zed).
 *     HTTP targets use forward-proxy with absolute-URI request line.
 *   - `signal` may be an AbortSignal. If aborted, sockets are destroyed.
 */
export async function proxiedFetch(urlStr, opts = {}) {
  const target = new URL(urlStr)
  const proxy = opts.proxy ? (typeof opts.proxy === 'string' ? parseProxy(opts.proxy) : opts.proxy) : null

  // Fallback: no proxy or proxy invalid   native fetch
  if (!proxy) {
    const r = await fetch(urlStr, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || undefined,
      signal: opts.signal,
    })
    // Buffer once for uniform shape (body getReader + text/arrayBuffer)
    const buf = Buffer.from(await r.arrayBuffer())
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buf))
        controller.close()
      },
    })
    return {
      status: r.status,
      headers: r.headers,
      body: webStream,
      async text() { return buf.toString('utf8') },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
      _cachedBuffer: buf,
    }
  }

  const method = (opts.method || 'GET').toUpperCase()
  const headers = { ...(opts.headers || {}) }
  const body = opts.body != null
    ? (Buffer.isBuffer(opts.body) ? opts.body : typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : Buffer.from(String(opts.body), 'utf8'))
    : null
  if (body && !headers['Content-Length'] && !headers['content-length']) headers['Content-Length'] = String(body.length)
  if (!headers['Host'] && !headers['host']) headers['Host'] = target.host
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'zed-gateway/1.0'
  if (!headers['Accept'] && !headers['accept']) headers['Accept'] = '*/*'
  if (!headers['Connection'] && !headers['connection']) headers['Connection'] = 'close'

  const timeoutMs = opts.timeoutMs ?? 120_000

  let socket
  if (target.protocol === 'https:') {
    if (proxy.protocol === 'socks5') {
      socket = await socks5Connect({ proxy, targetHost: target.hostname, targetPort: parseInt(target.port || '443', 10), signal: opts.signal, timeoutMs })
    } else {
      socket = await connectThroughHttpProxy({ proxy, targetHost: target.hostname, targetPort: parseInt(target.port || '443', 10), signal: opts.signal, timeoutMs })
    }
  } else {
    socket = net.connect({ host: proxy.host, port: proxy.port })
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('proxy dial timeout')), timeoutMs)
      socket.once('connect', () => { clearTimeout(t); res() })
      socket.once('error', (e) => { clearTimeout(t); rej(e) })
    })
  }

  const requestTarget = target.protocol === 'https:'
    ? (target.pathname || '/') + (target.search || '')
    : urlStr

  const resp = await sendHttpRequest(socket, {
    method,
    target: requestTarget,
    headers,
    body,
    signal: opts.signal,
    timeoutMs,
  })

  // Buffer body once, then expose as web ReadableStream for uniform access
  const bodyChunks = []
  for await (const c of resp.body) bodyChunks.push(c)
  const bodyBuffer = Buffer.concat(bodyChunks)

  const webStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bodyBuffer))
      controller.close()
    },
  })

  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
    body: webStream,
    async text() { return bodyBuffer.toString('utf8') },
    async arrayBuffer() { return bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength) },
    _cachedBuffer: bodyBuffer,
  }
}

//  Connectivity test (used by /admin/api/proxy/test) 

/**
 * Test a proxy by fetching an echo IP endpoint.
 * Returns { ok, ip, country, latencyMs } or { ok: false, error }.
 * Credentials are never returned.
 */
export async function testProxy(proxy, opts = {}) {
  const start = Date.now()
  try {
    const r = await proxiedFetch('https://api.ipify.org?format=json', {
      proxy,
      timeoutMs: opts.timeoutMs ?? 15_000,
      headers: { 'User-Agent': 'zed-gateway/1.0', 'Accept': 'application/json' },
    })
    if (r.status !== 200) {
      return { ok: false, error: `HTTP ${r.status}`, latencyMs: Date.now() - start }
    }
    const body = await r.text()
    let data
    try { data = JSON.parse(body) } catch { data = {} }
    return {
      ok: true,
      ip: data.ip || null,
      country: data.country || null,
      latencyMs: Date.now() - start,
    }
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start }
  }
}
