// Account rotation engine - per-model sticky index with disable/cooldown and state persistence.
// Extended with per-account proxy health tracking.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function createRotationEngine(config, log) {
  const statePath = config.stateFile
  mkdirSync(dirname(statePath), { recursive: true })

  const defaultCooldownMs = (config.defaultCooldownSeconds ?? 300) * 1000
  const timeoutCooldownMs = (config.timeoutCooldownSeconds ?? 30) * 1000
  const usageLimitCooldownMs = (config.usageLimitCooldownSeconds ?? 86400) * 1000
  const accountCount = config.accounts.length
  const modelLocks = new Map()

  // Proxy health state: Map<accountIndex, { healthy: boolean, lastChecked: number, lastError: string | null }>
  const proxyHealth = new Map()

  function loadState() {
    if (!existsSync(statePath)) {
      return { modelStates: {} }
    }
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      return {
        modelStates: parsed.modelStates && typeof parsed.modelStates === 'object' ? parsed.modelStates : {},
      }
    } catch {
      return { modelStates: {} }
    }
  }

  let state = loadState()

  function saveState() {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
      log('error', `[rotation] failed to save state: ${err.message}`)
    }
  }

  saveState()

  function getModelState(model) {
    const key = model || '__global__'
    if (!state.modelStates[key] || typeof state.modelStates[key] !== 'object') {
      state.modelStates[key] = { currentIndex: 0, disabled: {} }
    }
    const ms = state.modelStates[key]
    if (!Number.isInteger(ms.currentIndex)) ms.currentIndex = 0
    if (!ms.disabled || typeof ms.disabled !== 'object') ms.disabled = {}
    return ms
  }

  function cleanupDisabled(model) {
    const now = Date.now()
    const ms = getModelState(model)
    let changed = false
    for (const [index, until] of Object.entries(ms.disabled)) {
      if (typeof until !== 'number' || until <= now) {
        delete ms.disabled[index]
        changed = true
      }
    }
    if (changed) saveState()
  }

  function isDisabled(index, model) {
    cleanupDisabled(model)
    const ms = getModelState(model)
    return typeof ms.disabled[index] === 'number' && ms.disabled[index] > Date.now()
  }

  function disableAccount(index, model, cooldownMs) {
    const ms = getModelState(model)
    ms.disabled[index] = Date.now() + cooldownMs
    saveState()
    log('info', `[rotation] disabled account ${index} for model=${model} cooldown=${Math.round(cooldownMs / 1000)}s`)
  }

  function moveToNext(model) {
    const ms = getModelState(model)
    ms.currentIndex = (ms.currentIndex + 1) % accountCount
    saveState()
  }

  function pickAccount(model) {
    cleanupDisabled(model)
    if (accountCount === 0) return null

    const ms = getModelState(model)
    const start = ms.currentIndex % accountCount
    let idx = start
    do {
      if (!isDisabled(idx, model)) {
        if (idx !== ms.currentIndex) {
          ms.currentIndex = idx
          saveState()
        }
        return idx
      }
      idx = (idx + 1) % accountCount
    } while (idx !== start)

    return null // all disabled
  }

  //  Proxy health management 

  /**
   * Mark an account's proxy as healthy or unhealthy.
   * @param {number} idx - account index
   * @param {boolean} healthy - true if proxy works, false otherwise
   * @param {string} [error] - optional error message when unhealthy
   */
  function markProxyHealth(idx, healthy, error = null) {
    proxyHealth.set(idx, { healthy, lastChecked: Date.now(), lastError: error })
    log('debug', `[rotation] proxy health: account ${idx}   ${healthy ? 'healthy' : 'unhealthy'}${error ? ' (' + error + ')' : ''}`)
  }

  /**
   * Check if an account's proxy is considered healthy.
   * Returns true if no proxy is configured or proxy is marked healthy.
   * @param {number} idx - account index
   * @returns {boolean}
   */
  function isProxyHealthy(idx) {
    const account = config.accounts[idx]
    // If no proxy configured, always healthy
    if (!account?.proxy) return true
    const health = proxyHealth.get(idx)
    if (!health) return true // not checked yet, assume healthy
    return health.healthy
  }

  /**
   * Get proxy health status for an account.
   * @param {number} idx - account index
   * @returns {{ healthy: boolean, hasProxy: boolean, lastChecked: number|null, lastError: string|null }}
   */
  function getProxyHealth(idx) {
    const account = config.accounts[idx]
    const hasProxy = !!account?.proxy
    const health = proxyHealth.get(idx)
    return {
      hasProxy,
      healthy: health ? health.healthy : true,
      lastChecked: health?.lastChecked ?? null,
      lastError: health?.lastError ?? null,
    }
  }

  /**
   * Pick next account considering proxy health.
   * Skips accounts whose proxy is marked unhealthy.
   * @param {string} model - model name
   * @returns {number|null} account index or null if all unavailable
   */
  function getNextAccountWithProxy(model) {
    cleanupDisabled(model)
    if (accountCount === 0) return null

    const ms = getModelState(model)
    const start = ms.currentIndex % accountCount
    let idx = start
    do {
      if (!isDisabled(idx, model) && isProxyHealthy(idx)) {
        if (idx !== ms.currentIndex) {
          ms.currentIndex = idx
          saveState()
        }
        return idx
      }
      idx = (idx + 1) % accountCount
    } while (idx !== start)

    // Fallback: if all proxies are unhealthy, fall back to just non-disabled
    log('warn', `[rotation] all proxies unhealthy for model=${model}, falling back to any non-disabled`)
    idx = start
    do {
      if (!isDisabled(idx, model)) {
        if (idx !== ms.currentIndex) {
          ms.currentIndex = idx
          saveState()
        }
        return idx
      }
      idx = (idx + 1) % accountCount
    } while (idx !== start)

    return null
  }

  function getActiveCount(model) {
    cleanupDisabled(model)
    let count = 0
    for (let i = 0; i < accountCount; i++) {
      if (!isDisabled(i, model)) count++
    }
    return count
  }

  function classifyError(status, bodyText) {
    const text = (bodyText || '').toLowerCase()

    // Usage/quota limits - long cooldown
    const hasUsageLimit = [
      'usage limit', 'rate limit', 'quota exceeded', 'insufficient credits',
      'weekly usage limit', 'monthly limit', 'spending limit',
    ].some((needle) => text.includes(needle))

    if (hasUsageLimit) {
      return {
        shouldSwitch: true,
        reason: text.includes('weekly') ? 'weekly_usage_limit' : 'usage_limit',
        cooldownMs: usageLimitCooldownMs,
      }
    }

    if (status === 429) {
      return { shouldSwitch: true, reason: 'rate_limited_429', cooldownMs: defaultCooldownMs }
    }
    if (status === 401) {
      return { shouldSwitch: true, reason: 'unauthorized_401', cooldownMs: defaultCooldownMs }
    }
    if (status === 403) {
      return { shouldSwitch: true, reason: 'forbidden_403', cooldownMs: usageLimitCooldownMs }
    }
    if (status >= 500) {
      return { shouldSwitch: true, reason: `server_error_${status}`, cooldownMs: timeoutCooldownMs }
    }

    if (text.includes('authentication') || text.includes('unauthorized')) {
      return { shouldSwitch: true, reason: 'body_auth_error', cooldownMs: defaultCooldownMs }
    }

    return { shouldSwitch: false }
  }

  async function withModelLock(model, task) {
    const key = model || '__global__'
    const previous = modelLocks.get(key) || Promise.resolve()
    let release
    const current = new Promise((r) => { release = r })
    const queue = previous.then(() => current)
    modelLocks.set(key, queue)

    await previous
    try {
      return await task()
    } finally {
      release()
      if (modelLocks.get(key) === queue) {
        modelLocks.delete(key)
      }
    }
  }

  function getHealthSummary() {
    const summary = {}
    for (const [model, ms] of Object.entries(state.modelStates)) {
      const now = Date.now()
      summary[model] = {
        currentIndex: ms.currentIndex,
        activeAccounts: getActiveCount(model),
        disabled: Object.fromEntries(
          Object.entries(ms.disabled)
            .filter(([, until]) => until > now)
            .map(([idx, until]) => [idx, {
              until,
              remainingSeconds: Math.max(0, Math.ceil((until - now) / 1000)),
            }]),
        ),
      }
    }
    return summary
  }

  /**
   * Get proxy health summary for all accounts.
   * @returns {Array<{ idx: number, label: string, hasProxy: boolean, healthy: boolean, lastChecked: number|null, lastError: string|null }>}
   */
  function getProxyHealthSummary() {
    return config.accounts.map((acc, idx) => ({
      idx,
      label: acc.label,
      ...getProxyHealth(idx),
    }))
  }

  return {
    pickAccount,
    getNextAccountWithProxy,
    disableAccount,
    moveToNext,
    classifyError,
    getActiveCount,
    getHealthSummary,
    withModelLock,
    markProxyHealth,
    isProxyHealthy,
    getProxyHealth,
    getProxyHealthSummary,
    defaultCooldownMs,
    timeoutCooldownMs,
    usageLimitCooldownMs,
  }
}
