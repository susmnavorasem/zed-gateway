// Zed Cloud auth - exchange ACCESS_TOKEN for temporary LLM JWT, cache per account.
// Each account may carry an optional `proxy` field; when present, the LLM token
// exchange goes through that exact proxy (per-account exit IP).

import { proxiedFetch, maskProxy } from './proxy.mjs'

const ZED_LLM_TOKENS_URL = 'https://cloud.zed.dev/client/llm_tokens'
const USER_AGENT = 'Zed/0.200.0'
const PROACTIVE_REFRESH_MS = 5 * 60 * 1000 // refresh 5 min before expiry

function decodeJwtExpiry(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function maskToken(token) {
  if (!token || typeof token !== 'string') return '(none)'
  return token.substring(0, 8) + '...'
}

export function createAuthManager(accounts, log) {
  // Per-account cache: { llmToken, expiresAt }
  const cache = new Map()

  async function exchangeToken(account) {
    const authHeader = `${account.userId} ${account.accessToken}`
    const viaProxy = account.proxy ? ` via ${maskProxy(account.proxy)}` : ''
    log('debug', `[auth] exchanging token for ${account.label} userId=${account.userId}${viaProxy}`)

    const response = await proxiedFetch(ZED_LLM_TOKENS_URL, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: '{}',
      proxy: account.proxy || null,
    })

    if (response.status !== 200) {
      const body = await response.text().catch(() => '')
      throw new Error(`LLM token exchange failed: ${response.status} ${body.slice(0, 200)}`)
    }

    const data = JSON.parse(await response.text())
    const llmToken = data.token
    if (!llmToken) {
      throw new Error('LLM token exchange returned no token')
    }

    const expiresAt = decodeJwtExpiry(llmToken) || (Date.now() + 55 * 60 * 1000) // fallback ~55 min
    log('info', `[auth] ${account.label}: got LLM token ${maskToken(llmToken)}, expires in ${Math.round((expiresAt - Date.now()) / 1000)}s${viaProxy}`)

    return { llmToken, expiresAt }
  }

  function isValid(entry) {
    if (!entry || !entry.llmToken) return false
    return entry.expiresAt > Date.now() + PROACTIVE_REFRESH_MS
  }

  async function getToken(accountIndex) {
    const account = accounts[accountIndex]
    if (!account) throw new Error(`Invalid account index: ${accountIndex}`)

    const cached = cache.get(accountIndex)
    if (isValid(cached)) {
      return cached.llmToken
    }

    // Need to refresh
    log('info', `[auth] ${account.label}: refreshing LLM token${account.proxy ? ` via ${maskProxy(account.proxy)}` : ''}`)
    const entry = await exchangeToken(account)
    cache.set(accountIndex, entry)
    return entry.llmToken
  }

  function invalidateToken(accountIndex) {
    cache.delete(accountIndex)
    const account = accounts[accountIndex]
    if (account) {
      log('info', `[auth] ${account.label}: token invalidated`)
    }
  }

  function getCachedExpiry(accountIndex) {
    const cached = cache.get(accountIndex)
    return cached?.expiresAt ?? null
  }

  return { getToken, invalidateToken, getCachedExpiry }
}