// Admin panel - self-contained HTML page + API route handlers.

import { writeFileSync } from 'node:fs'
import { testProxy, maskProxy, parseProxy } from './proxy.mjs'
import { getLoginUrl, decryptToken } from './rsa.mjs'

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zed Gateway Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e; color: #e0e0e0; min-height: 100vh; padding: 20px;
  }
  h1 { color: #e94560; margin-bottom: 20px; font-size: 24px; }
  h2 { font-size: 16px; text-transform: uppercase; letter-spacing: 1px;
       margin-bottom: 12px; color: #e94560; }
  .container { max-width: 1100px; margin: 0 auto; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .header h1 { margin-bottom: 0; }
  .header-actions { display: flex; gap: 8px; }
  .card {
    background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 16px;
    border: 1px solid #0f3460;
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .stat {
    background: #0f3460; border-radius: 6px; padding: 14px; text-align: center;
  }
  .stat-value { font-size: 28px; font-weight: 700; color: #e94560; }
  .stat-label { font-size: 12px; color: #8888aa; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #0f3460; }
  th { color: #8888aa; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { font-size: 14px; }
  .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
    vertical-align: middle;
  }
  .dot-green { background: #00c853; }
  .dot-yellow { background: #ffd600; }
  .dot-red { background: #ff1744; }
  .dot-gray { background: #666; }
  button, .btn {
    background: #e94560; color: #fff; border: none; border-radius: 4px;
    padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 600;
    transition: background 0.15s;
  }
  button:hover, .btn:hover { background: #c73652; }
  button:disabled { background: #555; cursor: not-allowed; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-outline {
    background: transparent; border: 1px solid #e94560; color: #e94560;
  }
  .btn-outline:hover { background: #e94560; color: #fff; }
  .btn-danger { background: #b71c1c; }
  .btn-danger:hover { background: #d32f2f; }
  .btn-success { background: #2e7d32; }
  .btn-success:hover { background: #388e3c; }
  .btn-info { background: #1565c0; }
  .btn-info:hover { background: #1976d2; }
  .btn-link {
    background: transparent; color: #5c6bc0; border: none; text-decoration: underline;
    padding: 0; font-weight: 400;
  }
  .btn-link:hover { color: #7986cb; }
  input[type="text"] {
    background: #0f3460; border: 1px solid #1a3a6e; border-radius: 4px;
    color: #e0e0e0; padding: 8px 12px; font-size: 14px; width: 100%;
  }
  input[type="text"]::placeholder { color: #556; }
  input[type="text"]:focus { outline: none; border-color: #e94560; }
  .form-row { display: flex; gap: 10px; margin-bottom: 10px; align-items: end; }
  .form-group { flex: 1; }
  .form-group label { display: block; font-size: 12px; color: #8888aa; margin-bottom: 4px; }
  .toast {
    position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 6px;
    font-size: 14px; z-index: 1000; opacity: 0; transition: opacity 0.3s;
    max-width: 400px;
  }
  .toast.show { opacity: 1; }
  .toast-ok { background: #1b5e20; color: #c8e6c9; }
  .toast-err { background: #b71c1c; color: #ffcdd2; }
  .rotation-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
  .rotation-item {
    background: #0f3460; border-radius: 4px; padding: 8px 12px; font-size: 13px;
  }
  .rotation-model { font-weight: 600; color: #e94560; }
  .rotation-info { color: #8888aa; font-size: 12px; margin-top: 2px; }
  .mono { font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 13px; }
  .muted { color: #8888aa; }
  .proxy-masked { font-family: monospace; font-size: 12px; color: #8888aa; }
  .proxy-status { font-size: 12px; }
  .actions-cell { display: flex; gap: 4px; flex-wrap: wrap; }
  @media (max-width: 600px) {
    .form-row { flex-direction: column; }
    .header { flex-direction: column; gap: 12px; align-items: flex-start; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>&#9889; Zed Gateway Admin</h1>
    <div class="header-actions">
      <button onclick="doReload()" class="btn btn-success">Reload Config</button>
    </div>
  </div>

  <!-- Health overview -->
  <div class="card" id="health-card">
    <h2>Health Overview</h2>
    <div class="stats" id="health-stats">
      <div class="stat"><div class="stat-value" id="stat-total">-</div><div class="stat-label">Total Accounts</div></div>
      <div class="stat"><div class="stat-value" id="stat-active">-</div><div class="stat-label">Active</div></div>
      <div class="stat"><div class="stat-value" id="stat-models">-</div><div class="stat-label">Models</div></div>
      <div class="stat"><div class="stat-value" id="stat-uptime">-</div><div class="stat-label">Uptime (s)</div></div>
    </div>
  </div>

  <!-- Accounts -->
  <div class="card">
    <h2>Accounts</h2>
    <table>
      <thead><tr><th>Label</th><th>User ID</th><th>Proxy</th><th>Status</th><th>JWT</th><th>Actions</th></tr></thead>
      <tbody id="accounts-tbody"><tr><td colspan="6" class="muted">Loading...</td></tr></tbody>
    </table>
  </div>

  <!-- Add via Browser -->
  <div class="card">
    <h2>Add Account via Browser (New Clean Method!)</h2>
    <div class="form-row">
      <button onclick="doGenerateLink()" class="btn-success" style="white-space:nowrap">1. Generate Login Link</button>
      <input type="text" id="add-link" readonly style="flex:1" placeholder="Click generate and open this link in your browser" onclick="this.select()">
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:2">
        <label for="add-callback">2. Paste Callback URL (The page will say "Site can't be reached", just copy its URL here)</label>
        <input type="text" id="add-callback" placeholder="http://127.0.0.1:18090/?user_id=...&access_token=...">
      </div>
      <div class="form-group" style="flex:1">
        <label for="add-proxy">3. Proxy (optional)</label>
        <input type="text" id="add-proxy" placeholder="ip:port:user:pass">
      </div>
      <button onclick="doAdd()" style="align-self:end;white-space:nowrap">Save Account</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = '/admin/api';
let refreshTimer = null;

function toast(msg, ok) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (ok ? 'toast-ok' : 'toast-err');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 4000);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(API + path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || data.message || 'Request failed');
  return data;
}

function fmtUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

async function refreshHealth() {
  try {
    const h = await api('GET', '/health');
    document.getElementById('stat-total').textContent = h.accounts;
    document.getElementById('stat-active').textContent = h.activeAccounts ?? '-';
    document.getElementById('stat-models').textContent = h.models;
    document.getElementById('stat-uptime').textContent = fmtUptime(h.uptime);
  } catch(e) { console.error('health refresh failed', e); }
}

async function refreshAccounts() {
  try {
    const accs = await api('GET', '/accounts');
    const tbody = document.getElementById('accounts-tbody');
    if (!accs.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No accounts configured</td></tr>';
      return;
    }
    tbody.innerHTML = accs.map(a => {
      const dotCls = a.status === 'active' ? 'dot-green' : a.status === 'cooldown' ? 'dot-yellow' : 'dot-red';
      const jwtDot = a.jwt === 'cached' ? 'dot-green' : a.jwt === 'expired' ? 'dot-yellow' : 'dot-gray';
      const proxyDot = a.proxyStatus === 'ok' ? 'dot-green' : a.proxyStatus === 'fail' ? 'dot-red' : 'dot-gray';
      const proxyText = a.proxyMasked ? '<span class="dot ' + proxyDot + '"></span><span class="proxy-masked">' + esc(a.proxyMasked) + '</span>' : '<span class="muted">-</span>';
      return '<tr>'
        + '<td><strong>' + esc(a.label) + '</strong></td>'
        + '<td class="mono">' + esc(a.userId) + '</td>'
        + '<td>' + proxyText + '</td>'
        + '<td><span class="dot ' + dotCls + '"></span>' + esc(a.status) + '</td>'
        + '<td><span class="dot ' + jwtDot + '"></span>' + esc(a.jwt) + '</td>'
        + '<td class="actions-cell">'
        + (a.proxyMasked ? '<button class="btn-sm btn-info" onclick="testProxy(\\'' + esc(a.label) + '\\')">Test</button>' : '')
        + '<button class="btn-sm btn-danger" onclick="doRemove(\\'' + esc(a.label) + '\\')">Remove</button>'
        + '</td>'
        + '</tr>';
    }).join('');
  } catch(e) { console.error('accounts refresh failed', e); }
}

function esc(s) {
  const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
}

async function testProxy(label) {
  try {
    const r = await api('POST', '/proxy/test', { label });
    if (r.ok) {
      toast('Proxy OK: ' + r.ip + ' (' + r.latencyMs + 'ms)', true);
    } else {
      toast('Proxy FAIL: ' + r.error, false);
    }
    refreshAccounts();
  } catch(e) { toast('Test failed: ' + e.message, false); }
}

async function doGenerateLink() {
  try {
    const r = await api('GET', '/login-url');
    const el = document.getElementById('add-link');
    el.value = r.url;
    window.open(r.url, '_blank');
    toast('Login link generated and opened! Now login on the website.', true);
  } catch(e) { toast('Failed to generate link: ' + e.message, false); }
}

async function doAdd() {
  const callbackUrl = document.getElementById('add-callback').value.trim();
  const proxy = document.getElementById('add-proxy').value.trim();
  if (!callbackUrl) { toast('Callback URL is required', false); return; }
  try {
    const r = await api('POST', '/add', { callbackUrl, proxy: proxy || undefined });
    toast('Account added: ' + r.label, true);
    document.getElementById('add-callback').value = '';
    document.getElementById('add-proxy').value = '';
    refreshAll();
  } catch(e) { toast('Add failed: ' + e.message, false); }
}

async function doRemove(label) {
  if (!confirm('Remove account "' + label + '"?')) return;
  try {
    await api('DELETE', '/accounts/' + encodeURIComponent(label));
    toast('Removed: ' + label, true);
    refreshAll();
  } catch(e) { toast('Remove failed: ' + e.message, false); }
}

async function doReload() {
  try {
    await api('POST', '/reload');
    toast('Config reloaded', true);
    refreshAll();
  } catch(e) { toast('Reload failed: ' + e.message, false); }
}

function refreshAll() { refreshHealth(); refreshAccounts(); }

refreshAll();
refreshTimer = setInterval(refreshAll, 10000);
</script>
</body>
</html>