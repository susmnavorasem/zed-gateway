// Extract Zed credentials from Windows Credential Manager via PowerShell.

import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ZedCred {
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName;
        public string Comment; public long LastWritten; public int CredentialBlobSize;
        public IntPtr CredentialBlob; public int Persist; public int AttributeCount;
        public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    public static string Read(string target) {
        IntPtr credPtr;
        if (CredRead(target, 1, 0, out credPtr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            CredFree(credPtr);
            return "USER_ID=" + cred.UserName + "\\nACCESS_TOKEN=" + Encoding.UTF8.GetString(bytes);
        }
        return "NOT_FOUND";
    }
}
"@
[ZedCred]::Read("zed:url=https://zed.dev")
`

export function extractZedCredentials() {
  const scriptPath = join(tmpdir(), `zed-extract-${Date.now()}.ps1`)

  try {
    writeFileSync(scriptPath, PS_SCRIPT, 'utf8')

    const result = execSync(
      `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()

    if (!result || result === 'NOT_FOUND') {
      throw new Error('Zed credentials not found in Windows Credential Manager. Is Zed installed and logged in?')
    }

    const lines = result.split('\n').map(l => l.trim()).filter(Boolean)
    let userId = null
    let accessToken = null

    for (const line of lines) {
      if (line.startsWith('USER_ID=')) {
        userId = line.slice('USER_ID='.length)
      } else if (line.startsWith('ACCESS_TOKEN=')) {
        accessToken = line.slice('ACCESS_TOKEN='.length)
      }
    }

    if (!userId || !accessToken) {
      throw new Error(`Failed to parse credentials from output: ${result.slice(0, 200)}`)
    }

    return { userId, accessToken }
  } finally {
    try { unlinkSync(scriptPath) } catch {}
  }
}