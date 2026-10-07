// sign-in.mjs — Fully automated Zed account registration through proxy.
// Usage: node src/sign-in.mjs 31.56.127.193:7684:vdvydvqn:1qj8nwix6m7p
//
// What it does (zero manual steps):
// 1. Starts local proxy bridge (127.0.0.1:auto -> upstream with auth)
// 2. Sets Windows system proxy to 127.0.0.1:bridge (NO auth needed!)
// 3. Opens browser to zed.dev/account
// 4. Polls Credential Manager every 5s for new token
// 5. When found -> saves to config.json with proxy, clears system proxy
// 6. Prints "DONE" message

import { startProxyBridge } from './proxy-bridge.mjs'
import { setSystemProxy, clearSystemProxy } from './system-proxy.mjs'
import { extractZedCredentials } from './extract.mjs'
import { parseProxy, maskProxy } from './proxy.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const proxyArg = process.argv[2]
if (!proxyArg) {
  console.error('Usage: node src/sign-in.mjs <proxy>')
  console.error('  proxy: ip:port:user:pass')
  console.error('  Example: node src/sign-in.mjs 31.56.127.193:7684:vdvydvqn:1qj8nwix6m7p')
  process.exit(1)
}

const parsed = parseProxy(proxyArg)
if (!parsed) {
  console.error('Invalid proxy format:', proxyArg)
  process.exit(1)
}

const configPath = resolve(process.argv[3] || 'config.json')

console.log('')
console.log('=== Zed Gateway - Auto Sign-in ===')
console.log(`  Proxy: ${maskProxy(proxyArg)}`)
console.log(`  Config: ${configPath}`)
console.log('')

// Remember existing credentials before we start
let existingUserIds = new Set()
try {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  existingUserIds = new Set(cfg.accounts.map(a => a.userId))
} catch {}

// Step 1: Start local proxy bridge
console.log('[1/5] Starting local proxy bridge...')
let bridge
try {
  bridge = await startProxyBridge({
    upstream: proxyArg,
    port: 0, // auto-assign
    host: '127.0.0.1',
    log: (level, msg) => { if (level !== 'debug') console.log(`  [bridge] ${msg}`) },
  })
  console.log(`  OK: bridge on 127.0.0.1:${bridge.port} -> ${maskProxy(proxyArg)}`)
} catch (e) {
  console.error(`  FAILED: ${e.message}`)
  process.exit(1)
}

// Step 2: Set Windows system proxy to local bridge (NO auth needed!)
console.log('[2/5] Setting system proxy to local bridge...')
try {
  setSystemProxy({ host: '127.0.0.1', port: bridge.port })
  console.log(`  OK: system proxy = 127.0.0.1:${bridge.port}`)
} catch (e) {
  console.error(`  FAILED: ${e.message}`)
  bridge.close()
  process.exit(1)
}

// Step 3: Open browser
console.log('[3/5] Opening browser to zed.dev/account...')
try {
  execSync('start "" "https://zed.dev/account"', { stdio: 'ignore', shell: true })
  console.log('  OK: browser opened')
} catch {
  console.log('  Browser did not open automatically. Open this URL manually:')
  console.log('  https://zed.dev/account')
}

console.log('')
console.log('=============================================')
console.log('  NOW DO THIS:')
console.log('  1. Register on zed.dev (use new GitHub)')
console.log('  2. Open Zed IDE app and login')
console.log('  3. Activate 14-day Pro Trial')
console.log('  4. WAIT — I will detect the token automatically')
console.log('=============================================')
console.log('')
console.log('Polling for new token every 5 seconds...')

// Step 4: Poll for new credentials
let found = false
let attempts = 0
const maxAttempts = 360 // 30 minutes max

const pollInterval = setInterval(() => {
  attempts++
  try {
    const creds = extractZedCredentials()
    if (creds && creds.userId && !existingUserIds.has(creds.userId)) {
      // New account found!
      found = true
      clearInterval(pollInterval)

      console.log('')
      console.log(`  *** NEW ACCOUNT DETECTED! ***`)
      console.log(`  userId: ${creds.userId}`)
      console.log('')

      // Step 5: Save to config and cleanup
      console.log('[4/5] Saving to config.json...')
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
        const maxNum = cfg.accounts
          .map(a => { const m = a.label.match(/^account-(\d+)$/); return m ? parseInt(m[1], 10) : 0 })
          .reduce((a, b) => Math.max(a, b), 0)
        const label = `account-${maxNum + 1}`

        cfg.accounts.push({
          label,
          userId: creds.userId,
          accessToken: creds.accessToken,
          proxy: proxyArg,
        })

        writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
        console.log(`  OK: saved as "${label}" with proxy ${maskProxy(proxyArg)}`)
      } catch (e) {
        console.error(`  FAILED to save config: ${e.message}`)
      }

      // Clear system proxy
      console.log('[5/5] Clearing system proxy...')
      try {
        clearSystemProxy()
        console.log('  OK: system proxy cleared. Your internet is back to normal.')
      } catch (e) {
        console.error(`  FAILED to clear proxy: ${e.message}`)
        console.error('  Please clear it manually: Settings -> Network -> Proxy -> Off')
      }

      // Close bridge
      bridge.close()

      console.log('')
      console.log('=============================================')
      console.log('  DONE! Account registered and saved.')
      console.log('  You can close the browser now.')
      console.log('')
      console.log('  To start gateway:')
      console.log('    cd D:\\Provider\\zed-gateway')
      console.log('    node src/gateway.mjs config.json')
      console.log('')
      console.log('  Or just run: .\\start.bat')
      console.log('=============================================')
      console.log('')

      // Exit after 5 seconds
      setTimeout(() => process.exit(0), 5000)
    }
  } catch {
    // extractZedCredentials may throw if no creds found — that's normal
  }

  if (attempts % 12 === 0) {
    const mins = Math.round(attempts * 5 / 60)
    console.log(`  ... still waiting (${mins} min). Complete registration in the browser.`)
  }

  if (attempts >= maxAttempts) {
    clearInterval(pollInterval)
    console.log('')
    console.log('  TIMEOUT: No new account detected in 30 minutes.')
    console.log('  Clearing system proxy...')
    try { clearSystemProxy() } catch {}
    bridge.close()
    process.exit(1)
  }
}, 5000)

// Safety: clear proxy on exit
process.on('SIGINT', () => {
  console.log('\n  Interrupted. Clearing system proxy...')
  try { clearSystemProxy() } catch {}
  bridge.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  try { clearSystemProxy() } catch {}
  bridge.close()
  process.exit(0)
})
