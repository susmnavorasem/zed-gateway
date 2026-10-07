// zed-gateway - local OpenAI-compatible proxy for Zed Cloud API with account rotation.
// Pure Node.js, zero external dependencies. Requires Node >= 18.
//
// Per-account proxy support:
//   - Each account can have a `proxy` field
//   - Upstream requests go through the account's proxy via proxiedFetch
//   - Proxy failures trigger failover to next account
//   - System proxy is NEVER changed (local bridge only for browser)
//
// Account selection (optional override):
//   - Query:    ?account=label
//   - Path:     /gateway/label/v1/chat/completions
//   - Header:   X-Account-Label: label
//   If not specified, rotation engine picks the next account.

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createAuthManager } from './auth.mjs'
import { createRotationEngine } from './rotation.mjs'
import { convertToZedRequest, detectProvider, ALL_MODELS } from './converter.mjs'
import { createNdjsonToSseTransformer, bufferNdjsonResponse } from './stream.mjs'
import { createAdminHandlers } from './admin.mjs'
import { proxiedFetch, maskProxy, parseProxy } from './proxy.mjs'

// -- Config ------------------------------------------------------------------

const configPath = process.argv[2]
if (!configPath) {
  console.error('Usage: node src/gateway.mjs <config.json>')
  console.error('  Copy config.example.json -> config.json and fill in your accounts.')
  process.exit(1)
}

const resolvedPath = resolve(configPath)
if (!existsSync(resolvedPath)) {
  console.error(`Config not found: ${resolvedPath}`)
  process.exit(1)
}

let config = JSON.parse(readFileSync(resolvedPath, 'utf8'))
const PORT = config.port ?? 18090
const LOCAL_KEY = config.localKey || 'zed-local-key'
const REQUEST_TIMEOUT = config.requestTimeoutMs ?? 120_000
const MAX_FAILOVER = config.maxFailoverAttempts ?? 10
const MAX_BODY_SIZE = 10_485_760

const ZED_COMPLETIONS_URL = 'https://cloud.zed.dev/completions'
const USER_AGENT = 'Zed/0.200.0'

if (!Array.isArray(config.accounts)) {
  console.error('[FATAL] No accounts configured.')
  process.exit(1)
}

// -- Logging -----------------------------------------------------------------

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLogLevel = LOG_LEVELS[config.logLevel ?? 'info'] ?? 1

function log(level, msg, extra) {
  if ((LOG_LEVELS[level] ?? 1) < currentLogLevel) return
  const ts = new Date().toISOString()
  const tag = level.toUpperCase().padEnd(5)
  const suffix = extra ? ' ' + JSON.stringify(extra) : ''
  console.log(`[${ts}] ${tag} ${msg}${suffix}`)
}

// -- Create subsystems -------------------------------------------------------

let auth = createAuthManager(config.accounts, log)
let rotation = createRotationEngine(config, log)

// -- Hot-reload --------------------------------------------------------------

function reloadConfig() {
  const raw = readFileSync(resolvedPath, 'utf8')
  const newConfig = JSON.parse(raw)
  if (!Array.isArray(newConfig.accounts)) {
    throw new Error('Config must have an accounts array')
  }
  config = newConfig
  auth = createAuthManager(config.accounts, log)
  rotation = createRotationEngine(config, log)
  log('info', `[reload] config reloaded: ${config.accounts.length} accounts (${config.accounts.map(a => a.label).join(', ')})`)
}

// -- Helpers -----------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalSize = 0
    req.on('data', (chunk) => {
      totalSize += chunk.byteLength
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        reject({ status: 413, message: `Request body exceeds ${MAX_BODY_SIZE} bytes` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: 'error', code: status } })
}

function isAuthorized(req) {
  const authHeader = req.headers.authorization || ''
  return authHeader.toLowerCase() === `bearer ${LOCAL_KEY}`.toLowerCase()
}

function maskToken(token) {
  if (!token || typeof token !== 'string') return '(none)'
  return token.substring(0, 8) + '...'
}

// -- Account selection (override via query/path/header) ----------------------

/**
 * Resolve a requested account label from the request.
 * Priority: query param ?account= > path /gateway/label/... > header X-Account-Label
 * Returns the label string or null if not specified.
 */
function getRequestedAccountLabel(req, urlPath) {
  // 1. Query param
  const queryIdx = (req.url || '').indexOf('?')
  if (queryIdx !== -1) {
    const qs = req.url.slice(queryIdx + 1)
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=')
      if (k === 'account' && v) return decodeURIComponent(v)
    }
  }

  // 2. Path: /gateway/label/...
  const pathMatch = urlPath.match(/^\/gateway\/([^/]+)\//)
  if (pathMatch) return decodeURIComponent(pathMatch[1])

  // 3. Header
  const headerLabel = req.headers['x-account-label']
  if (headerLabel) return headerLabel.trim()

  return null
}

/**
 * Find account index by label. Returns -1 if not found.
 */
function findAccountIndexByLabel(label) {
  if (!label) return -1
  return config.accounts.findIndex(a => a.label === label)
}

// -- Admin panel -------------------------------------------------------------

const admin = createAdminHandlers({
  getConfig: () => config,
  getConfigPath: () => resolvedPath,
  getAuth: () => auth,
  getRotation: () => rotation,
  reloadConfig,
  log,
  readBody,
  sendJson,
  sendError,
  getModelCount: () => ALL_MODELS.length,
})

// -- Model list --------------------------------------------------------------

function getModelList() {
  return {
    object: 'list',
    data: ALL_MODELS.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'zed-gateway',
    })),
  }
}

// -- Stream upstream NDJSON response -> client SSE ---------------------------

async function streamUpstreamToClient(req, res, upstreamResponse, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-zed-model': model,
  })

  const transformer = createNdjsonToSseTransformer(res, model, log)
  const reader = upstreamResponse.body?.getReader()

  if (!reader) {
    log('error', 'Upstream returned no body for streaming', { model })
    transformer.finish()
    res.end()
    return
  }

  const decoder = new TextDecoder()
  let pending = ''
  let totalBytes = 0

  req.on('close', () => {
    reader.cancel().catch(() => {})
  })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      pending += decoder.decode(value, { stream: true })

      // Process complete lines
      const lines = pending.split('\n')
      pending = lines.pop() // keep incomplete last line
      for (const line of lines) {
        if (line.trim()) {
          transformer.processLine(line)
        }
      }
    }
  } catch (error) {
    log('error', 'Stream read error', { model, error: error.message })
  }

  // Flush remaining
  pending += decoder.decode()
  if (pending.trim()) {
    transformer.processLine(pending)
  }

  transformer.finish()
  log('info', 'stream complete', { model, bytes: totalBytes })
  res.end()
}

// -- Buffer upstream NDJSON response -> non-stream completion ----------------

async function bufferUpstreamToClient(res, upstreamResponse, model) {
  let body
  try {
    body = await upstreamResponse.text()
  } catch (e) {
    sendError(res, 502, `Failed to read upstream body: ${e.message}`)
    return
  }

  const completion = bufferNdjsonResponse(body, model)
  sendJson(res, 200, completion)
}

// -- Classify whether a network error is proxy-related ----------------------

function isProxyError(error) {
  if (!error) return false
  const msg = (error.message || '').toLowerCase()
  const proxyErrors = [
    'proxy', 'connect timeout', 'econnrefused', 'econnreset',
    'etimedout', 'socket hang up', 'tunnel', 'socks5',
    'enotfound', 'eai_again', 'network', 'socket',
  ]
  return proxyErrors.some(kw => msg.includes(kw))
}

// -- Make upstream request via proxiedFetch with account's proxy -------------

async function makeProxiedUpstreamRequest({ url, llmToken, body, signal, proxy, label }) {
  const viaProxy = proxy ? ` via ${maskProxy(proxy)}` : ''
  log('debug', `[upstream] ${label}: requesting${viaProxy}`)

  return await proxiedFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llmToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body,
    signal,
    proxy: proxy || null,
    timeoutMs: REQUEST_TIMEOUT,
  })
}

// -- Failover loop -----------------------------------------------------------

async function handleChatCompletion(req, res, bodyText) {
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    sendError(res, 400, 'Invalid JSON body')
    return
  }

  const model = parsed.model || 'claude-sonnet-5'
  const isStream = parsed.stream !== false // default to streaming

  if (!ALL_MODELS.includes(model)) {
    sendError(res, 400, `Unknown model: ${model}. Use GET /v1/models to see available models.`)
    return
  }

  // Convert to Zed format
  let zedBody
  try {
    zedBody = convertToZedRequest(parsed, model)
  } catch (e) {
    sendError(res, 400, `Request conversion failed: ${e.message}`)
    return
  }

  const zedBodyStr = JSON.stringify(zedBody)

  // Check if a specific account was requested
  const urlPath = req.url?.split('?')[0] || '/'
  const requestedLabel = getRequestedAccountLabel(req, urlPath)
  const requestedIdx = requestedLabel ? findAccountIndexByLabel(requestedLabel) : -1

  if (requestedLabel && requestedIdx === -1) {
    sendError(res, 404, `Account "${requestedLabel}" not found`)
    return
  }

  // Failover loop (with per-model lock)
  await rotation.withModelLock(model, async () => {
    const tried = new Set()
    const attempts = []
    let hardFailures = 0

    // If a specific account was requested, try it first
    const startIdx = requestedIdx !== -1 ? requestedIdx : rotation.getNextAccountWithProxy(model)

    if (startIdx === null) {
      sendError(res, 503, `All accounts unavailable for model ${model}`)
      return
    }

    // Build the order: requested first, then rotation order
    let currentIdx = startIdx
    while (tried.size < config.accounts.length && hardFailures < MAX_FAILOVER) {
      if (tried.has(currentIdx)) {
        // If we started with a requested account, continue with rotation
        if (requestedIdx !== -1 && tried.size === 1) {
          const nextIdx = rotation.getNextAccountWithProxy(model)
          if (nextIdx === null || tried.has(nextIdx)) break
          currentIdx = nextIdx
        } else {
          break
        }
      }
      if (tried.has(currentIdx)) break
      tried.add(currentIdx)

      const account = config.accounts[currentIdx]
      const accountProxy = account.proxy || null
      log('info', `  try model=${model} account=${account.label} idx=${currentIdx}${accountProxy ? ' proxy=' + maskProxy(accountProxy) : ' (no proxy)'}`)

      // Get LLM token
      let llmToken
      try {
        llmToken = await auth.getToken(currentIdx)
      } catch (e) {
        log('warn', `[auth] ${account.label}: token exchange failed: ${e.message}`)
        attempts.push({ idx: currentIdx, reason: 'auth_failed', error: e.message })
        rotation.disableAccount(currentIdx, model, rotation.defaultCooldownMs)
        rotation.markProxyHealth(currentIdx, false)
        rotation.moveToNext(model)
        hardFailures++
        currentIdx = rotation.getNextAccountWithProxy(model) ?? (currentIdx + 1) % config.accounts.length
        continue
      }

      // Make upstream request via proxiedFetch
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

      let upstreamResponse
      try {
        upstreamResponse = await makeProxiedUpstreamRequest({
          url: ZED_COMPLETIONS_URL,
          llmToken,
          body: zedBodyStr,
          signal: controller.signal,
          proxy: accountProxy,
          label: account.label,
        })
      } catch (error) {
        clearTimeout(timeoutId)
        const reason = error.name === 'AbortError' ? 'timeout' : (isProxyError(error) ? 'proxy_error' : 'network_error')
        log('warn', `? ${account.label}: ${reason}: ${error.message}`)
        attempts.push({ idx: currentIdx, reason, error: error.message })

        if (reason === 'proxy_error') {
          rotation.markProxyHealth(currentIdx, false)
        }

        rotation.disableAccount(currentIdx, model, rotation.timeoutCooldownMs)
        rotation.moveToNext(model)
        hardFailures++
        currentIdx = rotation.getNextAccountWithProxy(model) ?? (currentIdx + 1) % config.accounts.length
        continue
      }
      clearTimeout(timeoutId)

      const upstreamStatus = upstreamResponse.status

      // On 401 - try refreshing token once, then retry
      if (upstreamStatus === 401) {
        log('info', `${account.label}: 401 - invalidating JWT and retrying`)
        auth.invalidateToken(currentIdx)

        let retryToken
        try {
          retryToken = await auth.getToken(currentIdx)
        } catch (e) {
          log('warn', `${account.label}: token refresh failed: ${e.message}`)
          attempts.push({ idx: currentIdx, status: 401, reason: 'auth_refresh_failed' })
          rotation.disableAccount(currentIdx, model, rotation.defaultCooldownMs)
          rotation.markProxyHealth(currentIdx, false)
          rotation.moveToNext(model)
          hardFailures++
          currentIdx = rotation.getNextAccountWithProxy(model) ?? (currentIdx + 1) % config.accounts.length
          continue
        }

        // Retry with new token (through same proxy)
        const retryController = new AbortController()
        const retryTimeoutId = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT)

        try {
          upstreamResponse = await makeProxiedUpstreamRequest({
            url: ZED_COMPLETIONS_URL,
            llmToken: retryToken,
            body: zedBodyStr,
            signal: retryController.signal,
            proxy: accountProxy,
            label: account.label,
          })
        } catch (error) {
          clearTimeout(retryTimeoutId)
          const reason = error.name === 'AbortError' ? 'timeout' : (isProxyError(error) ? 'proxy_error' : 'retry_failed')
          log('warn', `${account.label}: retry failed: ${error.message}`)
          attempts.push({ idx: currentIdx, reason })
          if (reason === 'proxy_error') rotation.markProxyHealth(currentIdx, false)
          rotation.disableAccount(currentIdx, model, rotation.defaultCooldownMs)
          rotation.moveToNext(model)
          hardFailures++
          currentIdx = rotation.getNextAccountWithProxy(model) ?? (currentIdx + 1) % config.accounts.length
          continue
        }
        clearTimeout(retryTimeoutId)

        if (upstreamResponse.status === 401) {
          log('warn', `${account.label}: still 401 after token refresh`)
          attempts.push({ idx: currentIdx, status: 401, reason: 'persistent_401' })
          rotation.disableAccount(currentIdx, model, rotation.defaultCooldownMs)
          rotation.moveToNext(model)
          hardFailures++
          currentIdx = rotation.getNextAccountWithProxy(model) ?? (currentIdx + 1) % config.accounts.length
          continue
        }
      }

      // Check for other error statuses
      if (upstreamResponse.status >= 400) {
        let errorBody = ''
        try {
          errorBody = await upstreamResponse.text()
        } catch {}

        const classification = rotation.classifyError(upstreamResponse.status, errorBody)
        log('warn', `? ${account.label}: ${upstreamResponse.status} reason=${classification.reason}`, {
          body: errorBody.slice(0, 300),
        })
        attempts.push({ idx: currentIdx, status: upstreamResponse.status, reason: classification.reason })

        if (classification.shouldSwitch) {
          rotation.disableAccount(currentIdx, model, classification.cooldownMs)
          rotation.moveToNext(model)
          hardFailures++
          currentIdx = rotation.getNextAccountWithProxy(model) ?? (currentIdx + 1) % config.accounts.length
          continue
        }

        // Non-switchable error - pass through to client
        sendError(res, upstreamResponse.status, errorBody.slice(0, 1000))
        return
      }

      // Success - mark proxy as healthy
      if (accountProxy) {
        rotation.markProxyHealth(currentIdx, true)
      }

      // Success - stream or buffer the response
      log('info', `? ${account.label}: ${upstreamResponse.status} model=${model}${accountProxy ? ' via ' + maskProxy(accountProxy) : ''}`)

      if (isStream) {
        await streamUpstreamToClient(req, res, upstreamResponse, model)
      } else {
        await bufferUpstreamToClient(res, upstreamResponse, model)
      }
      return
    }

    // All attempts exhausted
    sendJson(res, 503, {
      error: {
        message: 'All accounts exhausted',
        type: 'server_error',
        model,
        activeAccounts: rotation.getActiveCount(model),
        attempts,
      },
    })
  })
}

// -- Health ------------------------------------------------------------------

function handleHealth(res) {
  sendJson(res, 200, {
    status: 'ok',
    gateway: 'zed-gateway',
    accounts: config.accounts.length,
    models: ALL_MODELS.length,
    uptime: Math.floor(process.uptime()),
    rotation: rotation.getHealthSummary(),
  })
}

// -- HTTP Server -------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = req.url?.split('?')[0] || '/'

  try {
    // Health - no auth required
    if (url === '/health' || url === '/') {
      handleHealth(res)
      return
    }

    // Admin routes - no auth required (local-only, gateway binds to 127.0.0.1)
    if (url === '/admin') {
      admin.serveAdminPage(res)
      return
    }
    if (url === '/admin/api/accounts' && req.method === 'GET') {
      admin.handleListAccounts(res)
      return
    }
    if (url === '/admin/api/add' && req.method === 'POST') {
      await admin.handleAdd(req, res)
      return
    }
    if (url.startsWith('/admin/api/accounts/') && req.method === 'DELETE') {
      const label = decodeURIComponent(url.slice('/admin/api/accounts/'.length))
      admin.handleRemove(res, label)
      return
    }
    if (url === '/admin/api/reload' && req.method === 'POST') {
      admin.handleReload(res)
      return
    }
    if (url === '/admin/api/health' && req.method === 'GET') {
      admin.handleHealth(res)
      return
    }
    if (url === '/admin/api/proxy/test' && req.method === 'POST') {
      await admin.handleTestProxy(req, res)
      return
    }
    if (url === '/admin/api/login-url' && req.method === 'GET') {
      admin.handleLoginUrl(res)
      return
    }

    // Auth check for API routes
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Unauthorized. Provide Bearer token via Authorization header.')
      return
    }

    // GET /v1/models
    if (req.method === 'GET' && url === '/v1/models') {
      sendJson(res, 200, getModelList())
      return
    }

    // POST /v1/chat/completions (and per-account variants)
    if (req.method === 'POST' && (
      url === '/v1/chat/completions' ||
      url.startsWith('/gateway/')
    )) {
      let bodyText
      try {
        bodyText = await readBody(req)
      } catch (err) {
        if (err && err.status === 413) {
          sendError(res, 413, err.message)
          return
        }
        throw err
      }
      await handleChatCompletion(req, res, bodyText)
      return
    }

    // 404
    sendError(res, 404, `Route not found: ${req.method} ${url}`)
  } catch (error) {
    log('error', 'Unhandled error', { url, method: req.method, error: error.message })
    if (!res.headersSent) {
      sendError(res, 500, 'Internal gateway error')
    }
  }
})

// -- Startup -----------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
  log('info', `zed-gateway listening on http://127.0.0.1:${PORT}`)
  log('info', `Accounts: ${config.accounts.length} (${config.accounts.map(a => a.label).join(', ')})`)
  log('info', `Models: ${ALL_MODELS.length}`)
  log('info', `Health: http://127.0.0.1:${PORT}/health`)
  log('info', `Admin:  http://127.0.0.1:${PORT}/admin`)
  log('info', `Chat:   POST http://127.0.0.1:${PORT}/v1/chat/completions`)
  log('info', `Models: GET  http://127.0.0.1:${PORT}/v1/models`)
})

// -- Graceful shutdown -------------------------------------------------------

let isShuttingDown = false

function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  log('info', `${signal} received, shutting down...`)
  server.close(() => {
    log('info', 'Server closed')
    process.exit(0)
  })
  setTimeout(() => {
    log('warn', 'Forced shutdown after 5s timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
