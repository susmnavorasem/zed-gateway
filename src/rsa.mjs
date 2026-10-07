import crypto from 'node:crypto'

let _privateKey = null
let _publicKeyDerBase64 = null

function initRsa() {
  if (_privateKey) return
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  _privateKey = privateKey
  _publicKeyDerBase64 = publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64url')
}

export function getLoginUrl() {
  initRsa()
  return `https://zed.dev/native_app_signin?native_app_port=18090&native_app_public_key=${_publicKeyDerBase64}`
}

export function decryptToken(encryptedB64) {
  if (!_privateKey) throw new Error("RSA keys not initialized. Generate a login link first.")
  
  const encryptedBuffer = Buffer.from(encryptedB64, 'base64url')
  const decryptedBuffer = crypto.privateDecrypt(
    {
      key: _privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    encryptedBuffer
  )
  return decryptedBuffer.toString('utf8')
}
