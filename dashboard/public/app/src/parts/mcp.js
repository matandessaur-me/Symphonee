// ═══ MCP client UI ═════════════════════════════════════════════════════════
async function refreshMcpServers() {
  const host = document.getElementById('mcpServersList');
  if (!host) return;
  try {
    const r = await fetch('/api/mcp/servers');
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      host.innerHTML = '<div style="color:var(--subtext0);padding:12px;">No servers configured.</div>';
      return;
    }
    host.innerHTML = list.map(renderMcpServerCard).join('');
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  } catch (e) {
    host.innerHTML = '<div style="color:var(--red);padding:12px;">Failed to load MCP servers: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderMcpServerCard(s) {
  const statusColor = s.connected ? 'var(--green)' : (s.enabled ? 'var(--yellow)' : 'var(--subtext0)');
  const statusText = s.connected ? 'Connected' : (s.enabled ? 'Disconnected' : 'Disabled');
  const toolCount = (s.tools || []).length;
  const resCount = (s.resources || []).length;
  const prCount = (s.prompts || []).length;
  return `
    <div style="border:1px solid var(--surface2);border-radius:var(--radius);padding:10px 12px;background:var(--surface0);">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};"></div>
        <strong style="font-size:12px;">${escapeHtml(s.name)}</strong>
        <span style="color:var(--subtext0);font-size:10px;">${statusText}</span>
        <div style="flex:1;"></div>
        <button onclick="toggleMcp('${encodeURIComponent(s.name)}', ${!s.enabled})" style="font-size:10px;padding:3px 8px;background:var(--surface1);border:1px solid var(--surface2);color:var(--text);border-radius:4px;cursor:pointer;">${s.enabled ? 'Disable' : 'Enable'}</button>
        <button onclick="refreshMcp('${encodeURIComponent(s.name)}')" title="Refresh catalogue" style="font-size:10px;padding:3px 8px;background:var(--surface1);border:1px solid var(--surface2);color:var(--text);border-radius:4px;cursor:pointer;"><i data-lucide="refresh-cw" style="width:10px;height:10px;"></i></button>
        <button onclick="removeMcp('${encodeURIComponent(s.name)}')" title="Remove" style="font-size:10px;padding:3px 8px;background:var(--surface1);border:1px solid var(--surface2);color:var(--red);border-radius:4px;cursor:pointer;"><i data-lucide="trash-2" style="width:10px;height:10px;"></i></button>
      </div>
      <div style="color:var(--subtext0);font-size:10px;font-family:var(--font-mono);margin-top:4px;word-break:break-all;">${escapeHtml(s.command)} ${(s.args || []).map(escapeHtml).join(' ')}</div>
      <div style="color:var(--subtext0);font-size:10px;margin-top:6px;">${toolCount} tool${toolCount===1?'':'s'} · ${resCount} resource${resCount===1?'':'s'} · ${prCount} prompt${prCount===1?'':'s'}${s.error ? ' · <span style="color:var(--red);">' + escapeHtml(s.error) + '</span>' : ''}</div>
      ${toolCount ? `<details style="margin-top:6px;"><summary style="font-size:11px;cursor:pointer;color:var(--subtext0);">Tools</summary><div style="margin-top:4px;font-size:10px;font-family:var(--font-mono);color:var(--text);max-height:160px;overflow:auto;">${(s.tools).map(t=>`<div>${escapeHtml(t.name)}${t.description?' — <span style="color:var(--subtext0);">'+escapeHtml(t.description)+'</span>':''}</div>`).join('')}</div></details>` : ''}
    </div>`;
}

async function addMcpServer() {
  const name = document.getElementById('mcpNewName').value.trim();
  const command = document.getElementById('mcpNewCommand').value.trim();
  const argsRaw = document.getElementById('mcpNewArgs').value.trim();
  const envRaw = document.getElementById('mcpNewEnv').value.trim();
  if (!name || !command) { toast('Name and command are required', 'error'); return; }
  const args = argsRaw ? argsRaw.split(/\s+/) : [];
  const env = {};
  for (const line of envRaw.split(/\n+/).map(l => l.trim()).filter(Boolean)) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  try {
    const r = await fetch('/api/mcp/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, command, args, env, enabled: true }) });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error || r.statusText); }
    document.getElementById('mcpNewName').value = '';
    document.getElementById('mcpNewCommand').value = '';
    document.getElementById('mcpNewArgs').value = '';
    document.getElementById('mcpNewEnv').value = '';
    toast('MCP server added', 'success');
    refreshMcpServers();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function toggleMcp(nameEnc, enabled) {
  try {
    await fetch(`/api/mcp/servers/${nameEnc}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    refreshMcpServers();
  } catch (e) { toast('Toggle failed: ' + e.message, 'error'); }
}

async function refreshMcp(nameEnc) {
  try {
    await fetch(`/api/mcp/servers/${nameEnc}/refresh`, { method: 'POST' });
    refreshMcpServers();
  } catch (e) { toast('Refresh failed: ' + e.message, 'error'); }
}

async function removeMcp(nameEnc) {
  if (!confirm('Remove this MCP server?')) return;
  try {
    await fetch(`/api/mcp/servers/${nameEnc}`, { method: 'DELETE' });
    refreshMcpServers();
  } catch (e) { toast('Remove failed: ' + e.message, 'error'); }
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }



