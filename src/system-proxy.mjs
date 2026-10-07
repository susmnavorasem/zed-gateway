// Windows system proxy — set/clear HKCU\...\Internet Settings via PowerShell.
// The system-wide browser proxy is used only while the user is signing in
// to a Zed account through a browser, so the GitHub OAuth handshake shares
// the same exit IP as the API calls. The local proxy bridge handles auth.
//
// Exported:
//   setSystemProxy({ host, port }) -> { ok, pid }
//   clearSystemProxy()             -> { ok, pid, wasEnabled }
//   getSystemProxy()               -> { enabled, server } | null

import { execSync } from 'node:child_process'

const INTERNET_SETTINGS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

// Refresh Wininet so the change takes effect immediately for browsers.
// cmd.exe must remain a single line for PowerShell-via-cmd compatibility.
const REFRESH_MARKER = '::REFRESHPID::'

function runPowerShell(script) {
  return execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"').replace(/\r?\n/g, ';')}"`,
    { encoding: 'utf8', timeout: 10_000 },
  )
}

/**
 * Set the Windows system HTTP/HTTPS proxy.
 * { host, port } — typically 127.0.0.1:{local bridge port}
 */
export function setSystemProxy({ host, port }) {
  if (!host || !port) throw new Error('setSystemProxy: host and port required')
  const server = `${host}:${port}`
  const ps = [
    `Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyEnable -Value 1`,
    `Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyServer -Value '${server}'`,
    `Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyOverride -Value '<local>;localhost;127.0.0.1'`,
    `& {
      $signature = '[DllImport(\"wininet.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
      $type = Add-Type -MemberDefinition $signature -Name 'Wininet' -Namespace 'PInvoke' -PassThru
      $INTERNET_OPTION_SETTINGS_CHANGED = 39
      $INTERNET_OPTION_REFRESH = 37
      [void]$type::InternetSetOption([IntPtr]::Zero, $INTERNET_OPTION_SETTINGS_CHANGED, [IntPtr]::Zero, 0)
      [void]$type::InternetSetOption([IntPtr]::Zero, $INTERNET_OPTION_REFRESH, [IntPtr]::Zero, 0)
      Write-Output '${REFRESH_MARKER}'
    }`,
  ].join(';')
  const out = runPowerShell(ps)
  return { ok: out.includes(REFRESH_MARKER), server }
}

/**
 * Clear the Windows system proxy.
 * Returns { ok, wasEnabled }.
 */
export function clearSystemProxy() {
  const before = getSystemProxy()
  const wasEnabled = before?.enabled === true
  const ps = [
    `Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyEnable -Value 0`,
    `& {
      $signature = '[DllImport(\"wininet.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
      $type = Add-Type -MemberDefinition $signature -Name 'Wininet' -Namespace 'PInvoke' -PassThru
      $INTERNET_OPTION_SETTINGS_CHANGED = 39
      $INTERNET_OPTION_REFRESH = 37
      [void]$type::InternetSetOption([IntPtr]::Zero, $INTERNET_OPTION_SETTINGS_CHANGED, [IntPtr]::Zero, 0)
      [void]$type::InternetSetOption([IntPtr]::Zero, $INTERNET_OPTION_REFRESH, [IntPtr]::Zero, 0)
      Write-Output '${REFRESH_MARKER}'
    }`,
  ].join(';')
  const out = runPowerShell(ps)
  return { ok: out.includes(REFRESH_MARKER), wasEnabled }
}

/**
 * Read the current system proxy state.
 */
export function getSystemProxy() {
  try {
    const out = runPowerShell(
      `(Get-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyEnable,ProxyServer -ErrorAction SilentlyContinue | `+
      `ForEach-Object { $_.ProxyEnable.ToString() + '|' + ($_.ProxyServer -as [string]) })`
    ).trim()
    const [enableRaw, server] = out.split('|')
    return { enabled: enableRaw === 'True' || enableRaw === '1', server: server || null }
  } catch {
    return null
  }
}
