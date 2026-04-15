/**
 * Symphonee -- MCP client manager.
 *
 * Connects to one or more external MCP servers over stdio (and, eventually,
 * Streamable HTTP). Each server is spawned as a child process; we framer
 * JSON-RPC messages over its stdin/stdout.
 *
 * Server configs persist in config.json under MCPServers:
 *   "MCPServers": [
 *     { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {...}, "enabled": true }
 *   ]
 *
 * Public API:
 *   listServers()            -> [{ name, connected, tools[], resources[], prompts[] }]
 *   addServer(cfg)           -> persists + connects
 *   removeServer(name)       -> disconnects + removes
 *   setEnabled(name, bool)   -> toggle
 *   callTool(name, tool, args) -> forward to remote server's tools/call
 *   readResource(name, uri)
 *   getPrompt(name, promptName, args)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-11-25';

class MCPServerConnection {
  constructor(cfg) {
    this.name = cfg.name;
    this.cfg = cfg;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.capabilities = null;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.connected = false;
    this.error = null;
  }

  async connect() {
    if (this.proc) return;
    try {
      this.proc = spawn(this.cfg.command, this.cfg.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.cfg.env || {}) },
        shell: process.platform === 'win32',
      });
    } catch (err) {
      this.error = err.message;
      throw err;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[mcp-client:${this.name}] ${chunk}`);
    });
    this.proc.on('exit', (code) => {
      this.connected = false;
      this.proc = null;
      this.error = `exited with code ${code}`;
      for (const { reject } of this.pending.values()) reject(new Error(this.error));
      this.pending.clear();
    });
    this.proc.on('error', (err) => {
      this.error = err.message;
      this.connected = false;
    });

    // Handshake
    const initResp = await this._send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: { name: 'symphonee', version: '0.1.0' },
    });
    this.capabilities = initResp && initResp.capabilities;
    this._sendNotification('notifications/initialized');
    this.connected = true;

    // Fetch catalogue
    await this.refresh();
  }

  async refresh() {
    if (!this.proc) return;
    try {
      if (this.capabilities && this.capabilities.tools) {
        const r = await this._send('tools/list');
        this.tools = (r && r.tools) || [];
      }
    } catch (_) { this.tools = []; }
    try {
      if (this.capabilities && this.capabilities.resources) {
        const r = await this._send('resources/list');
        this.resources = (r && r.resources) || [];
      }
    } catch (_) { this.resources = []; }
    try {
      if (this.capabilities && this.capabilities.prompts) {
        const r = await this._send('prompts/list');
        this.prompts = (r && r.prompts) || [];
      }
    } catch (_) { this.prompts = []; }
  }

  disconnect() {
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
    this.connected = false;
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('not connected'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      // Timeout safety
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout on ${method}`));
        }
      }, 60000);
    });
  }

  _sendNotification(method, params) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error(msg.error.message || 'rpc error'), { code: msg.error.code, data: msg.error.data }));
        else resolve(msg.result);
      }
      // Notifications and server-initiated requests are ignored for now.
    }
  }

  toJSON() {
    return {
      name: this.name,
      connected: this.connected,
      error: this.error,
      command: this.cfg.command,
      args: this.cfg.args || [],
      enabled: this.cfg.enabled !== false,
      capabilities: this.capabilities,
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
    };
  }
}

class MCPClientManager {
  constructor({ configPath }) {
    this.configPath = configPath;
    this.servers = new Map();
  }

  _readConfig() {
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (_) { return {}; }
  }

  _writeConfig(cfg) {
    if (typeof global.__markConfigSelfWrite === 'function') global.__markConfigSelfWrite();
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  _list() {
    const cfg = this._readConfig();
    return Array.isArray(cfg.MCPServers) ? cfg.MCPServers : [];
  }

  async bootstrap() {
    const list = this._list();
    for (const s of list) {
      if (s.enabled === false) continue;
      try {
        const conn = new MCPServerConnection(s);
        this.servers.set(s.name, conn);
        await conn.connect();
      } catch (err) {
        process.stderr.write(`[mcp-client] failed to start ${s.name}: ${err.message}\n`);
      }
    }
  }

  listServers() {
    const persisted = this._list();
    const out = [];
    for (const cfg of persisted) {
      const conn = this.servers.get(cfg.name);
      if (conn) out.push(conn.toJSON());
      else out.push({ name: cfg.name, connected: false, enabled: cfg.enabled !== false, command: cfg.command, args: cfg.args || [], tools: [], resources: [], prompts: [] });
    }
    return out;
  }

  async addServer(cfg) {
    if (!cfg || !cfg.name || !cfg.command) throw new Error('name and command required');
    const full = this._readConfig();
    full.MCPServers = Array.isArray(full.MCPServers) ? full.MCPServers : [];
    full.MCPServers = full.MCPServers.filter(s => s.name !== cfg.name);
    full.MCPServers.push({ name: cfg.name, command: cfg.command, args: cfg.args || [], env: cfg.env || {}, enabled: cfg.enabled !== false });
    this._writeConfig(full);
    // Disconnect any existing
    const existing = this.servers.get(cfg.name);
    if (existing) existing.disconnect();
    if (cfg.enabled !== false) {
      const conn = new MCPServerConnection(cfg);
      this.servers.set(cfg.name, conn);
      await conn.connect();
    }
    return this.listServers().find(s => s.name === cfg.name);
  }

  async removeServer(name) {
    const existing = this.servers.get(name);
    if (existing) existing.disconnect();
    this.servers.delete(name);
    const full = this._readConfig();
    full.MCPServers = (full.MCPServers || []).filter(s => s.name !== name);
    this._writeConfig(full);
    return { ok: true };
  }

  async setEnabled(name, enabled) {
    const full = this._readConfig();
    full.MCPServers = full.MCPServers || [];
    const entry = full.MCPServers.find(s => s.name === name);
    if (!entry) throw new Error(`No such server: ${name}`);
    entry.enabled = !!enabled;
    this._writeConfig(full);
    const existing = this.servers.get(name);
    if (!enabled && existing) existing.disconnect();
    if (enabled && !existing) {
      const conn = new MCPServerConnection(entry);
      this.servers.set(name, conn);
      try { await conn.connect(); } catch (_) {}
    }
    return this.listServers().find(s => s.name === name);
  }

  async callTool(serverName, toolName, args) {
    const conn = this.servers.get(serverName);
    if (!conn || !conn.connected) throw new Error(`Server not connected: ${serverName}`);
    return conn._send('tools/call', { name: toolName, arguments: args || {} });
  }

  async readResource(serverName, uri) {
    const conn = this.servers.get(serverName);
    if (!conn || !conn.connected) throw new Error(`Server not connected: ${serverName}`);
    return conn._send('resources/read', { uri });
  }

  async getPrompt(serverName, promptName, args) {
    const conn = this.servers.get(serverName);
    if (!conn || !conn.connected) throw new Error(`Server not connected: ${serverName}`);
    return conn._send('prompts/get', { name: promptName, arguments: args || {} });
  }

  async refresh(serverName) {
    const conn = this.servers.get(serverName);
    if (!conn) throw new Error(`No such server: ${serverName}`);
    await conn.refresh();
    return conn.toJSON();
  }
}

module.exports = { MCPClientManager, MCPServerConnection };
