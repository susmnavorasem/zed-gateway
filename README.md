# Zed Gateway

Local OpenAI-compatible proxy for Zed Cloud API with multi-account rotation.

Accepts standard OpenAI API requests, translates them into Zed Cloud format (Anthropic/OpenAI/Google provider-specific), rotates across multiple Zed Pro accounts on exhaustion, and streams responses back as OpenAI SSE.

Zero external dependencies. Node.js >= 18 only.

## Available Models

| Provider | Models |
|----------|--------|
| Anthropic | claude-sonnet-5, claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5 |
| OpenAI | gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.2, gpt-5-mini, gpt-5-nano |
| Google | gemini-3.1-pro-preview, gemini-3.5-flash, gemini-3-flash |

## Setup

### 1. Extract Zed Credentials

You need \`userId\` and \`accessToken\` from Zed. Run this in PowerShell:

\`\`\`powershell
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
            return "USER_ID=" + cred.UserName + "\nACCESS_TOKEN=" + Encoding.UTF8.GetString(bytes);
        }
        return "NOT FOUND";
    }
}
"@
[ZedCred]::Read("zed:url=https://zed.dev")
\`\`\`

### 2. Configure Accounts

Copy \`config.example.json\` to \`config.json\` and fill in your accounts:

\`\`\`json
{
  "name": "zed-gateway",
  "port": 18090,
  "localKey": "your-secret-key",
  "stateFile": "runtime/state/zed.json",
  "accounts": [
    {
      "label": "main",
      "userId": "991046",
      "accessToken": "{\"version\":2,\"id\":\"client_token_xxx\",\"token\":\"UgYc...\"}"
    }
  ]
}
\`\`\`

### 3. Start

\`\`\`bash
# Quick start
start.bat

# Or manually
node src/gateway.mjs config.json
\`\`\`
