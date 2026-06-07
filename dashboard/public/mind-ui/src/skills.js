// mind-ui :: skills module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, state } from './core.js';
import { escapeHtml } from './helpers.js';
import { render } from './router.js';
import { _toast } from './specs.js';

  const MindSkills = {
    state: { skills: [], proposals: [], selectedId: null, editing: false, current: null },
    md(s) { try { return (typeof window.renderMarkdownToHtml === 'function') ? window.renderMarkdownToHtml(s || '') : escapeHtml(s || '').replace(/\n/g, '<br>'); } catch (_) { return escapeHtml(s || ''); } },
    render() {
      const main = $('mindMain'); if (!main) return;
      main.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--surface0);flex-shrink:0;">' +
          '<span style="font-size:13px;font-weight:600;color:var(--text);">Skills</span>' +
          '<span style="font-size:11px;color:var(--subtext0);">how we work, consistently -- procedures every CLI follows</span>' +
          '<span style="flex:1;"></span>' +
          '<button class="tab-bar-btn" style="font-size:11px;" onclick="MindSkills.reflect()" title="Mine Mind corrections into proposed skills">Reflect now</button>' +
          '<button class="tab-bar-btn" style="font-size:11px;background:var(--accent);color:#000;border:none;font-weight:600;" onclick="MindSkills.newSkill()">New skill</button>' +
        '</div>' +
        '<div style="flex:1;display:flex;min-height:0;">' +
          '<div id="skMindList" style="width:300px;flex-shrink:0;border-right:1px solid var(--surface0);overflow-y:auto;padding:10px;"></div>' +
          '<div id="skMindDetail" style="flex:1;min-width:0;overflow-y:auto;padding:18px 22px;"></div>' +
        '</div>';
      this.load();
    },
    async load() {
      try {
        const [s, p] = await Promise.all([
          fetch('/api/skills').then(r => r.json()).catch(() => ({ skills: [] })),
          fetch('/api/skills/proposals').then(r => r.json()).catch(() => ({ proposals: [] })),
        ]);
        this.state.skills = s.skills || [];
        this.state.proposals = p.proposals || [];
      } catch (_) {}
      this.renderList();
      if (this.state.selectedId && this.state.skills.find(x => x.id === this.state.selectedId)) this.select(this.state.selectedId);
      else this.detailEmpty();
    },
    renderList() {
      const host = document.getElementById('skMindList'); if (!host) return;
      let html = '';
      const props = this.state.proposals || [];
      if (props.length) {
        html += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--yellow);margin:2px 4px 8px;">Proposed by reflection (' + props.length + ')</div>';
        for (const p of props) {
          html += '<div style="background:color-mix(in srgb, var(--yellow) 10%, var(--surface0));border:1px solid color-mix(in srgb, var(--yellow) 30%, var(--surface2));border-radius:8px;padding:9px 10px;margin-bottom:6px;">' +
            '<div style="font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:3px;">' + escapeHtml(p.name) + '</div>' +
            '<div style="font-size:10.5px;color:var(--subtext0);line-height:1.4;margin-bottom:7px;">' + escapeHtml(p.description) + '</div>' +
            '<div style="display:flex;gap:6px;">' +
              '<button class="tab-bar-btn" style="font-size:11px;" onclick="MindSkills.review(\'' + escapeHtml(p.id) + '\')">Review</button>' +
              '<button style="font-size:11px;padding:4px 9px;background:var(--green);border:none;border-radius:5px;color:#000;font-weight:600;cursor:pointer;" onclick="MindSkills.accept(\'' + escapeHtml(p.id) + '\')">Accept</button>' +
              '<button style="font-size:11px;padding:4px 9px;background:var(--surface1);border:1px solid var(--surface2);border-radius:5px;color:var(--red);cursor:pointer;" onclick="MindSkills.reject(\'' + escapeHtml(p.id) + '\')">Reject</button>' +
            '</div></div>';
        }
        html += '<div style="height:10px;"></div>';
      }
      html += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--subtext0);margin:2px 4px 8px;">Skills (' + this.state.skills.length + ')</div>';
      if (!this.state.skills.length) html += '<div style="font-size:11px;color:var(--subtext0);padding:8px;">No skills yet. Click "New skill".</div>';
      for (const s of this.state.skills) {
        const sel = this.state.selectedId === s.id && !this.state.editing;
        html += '<div onclick="MindSkills.select(\'' + escapeHtml(s.id) + '\')" style="cursor:pointer;border-radius:8px;padding:9px 10px;margin-bottom:4px;' + (sel ? 'background:color-mix(in srgb, var(--accent) 18%, var(--surface0));' : '') + '">' +
          '<div style="font-size:12.5px;font-weight:600;color:var(--text);">' + escapeHtml(s.name) + '</div>' +
          '<div style="font-size:10.5px;color:var(--subtext0);line-height:1.4;">' + escapeHtml(s.description) + '</div>' +
        '</div>';
      }
      host.innerHTML = html;
    },
    detailEmpty() {
      const d = document.getElementById('skMindDetail');
      if (d) d.innerHTML = '<div style="color:var(--subtext0);font-size:12px;padding:24px;text-align:center;">Select a skill to view it, review a proposal, or create a new one.<br><br>Skills are the procedures every CLI follows so behaviour stays consistent. Proposals are drafted by the reflection loop from your Mind corrections -- accept to make them real.</div>';
    },
    async select(id) {
      this.state.selectedId = id; this.state.editing = false; this.renderList();
      const d = document.getElementById('skMindDetail'); if (!d) return;
      d.innerHTML = '<div style="color:var(--subtext0);font-size:12px;padding:20px;">Loading...</div>';
      let skill = null;
      try { const r = await fetch('/api/skills/item?id=' + encodeURIComponent(id)).then(x => x.json()); if (r.ok) skill = r.skill; } catch (_) {}
      if (!skill) { d.innerHTML = '<div style="color:var(--red);font-size:12px;padding:20px;">Could not load skill.</div>'; return; }
      this.state.current = skill;
      d.innerHTML =
        '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:16px;font-weight:700;color:var(--text);">' + escapeHtml(skill.name) + '</div>' +
            '<div style="font-size:12px;color:var(--subtext0);margin-top:3px;">' + escapeHtml(skill.description) + '</div>' +
            '<div style="margin-top:7px;display:flex;gap:5px;flex-wrap:wrap;align-items:center;">' + (skill.tags || []).map(t => '<span style="font-size:9.5px;background:var(--surface1);color:var(--subtext0);padding:2px 7px;border-radius:8px;">' + escapeHtml(t) + '</span>').join('') + '<code style="font-size:9.5px;color:var(--overlay1);">' + escapeHtml(skill.id) + '</code></div>' +
          '</div>' +
          '<button class="tab-bar-btn" style="font-size:12px;" onclick="MindSkills.edit()">Edit</button>' +
          '<button class="tab-bar-btn" style="font-size:12px;color:var(--red);" onclick="MindSkills.del(\'' + escapeHtml(skill.id) + '\')">Delete</button>' +
        '</div>' +
        '<div style="border-top:1px solid var(--surface0);padding-top:14px;font-size:13px;line-height:1.55;color:var(--text);">' + this.md(skill.body || '') + '</div>';
    },
    edit() { this.editForm(this.state.current || {}, {}); },
    newSkill() { this.state.selectedId = null; this.editForm({ id: '', name: '', description: '', when: '', tags: [], body: '## Use when\n- \n\n## Do not use when\n- \n\n## Steps (primary path)\n1. \n\n## Safety\n- \n\n## Verification\n- \n' }, {}); },
    review(id) { const p = (this.state.proposals || []).find(x => x.id === id); if (p) this.editForm(p, { accept: true }); },
    editForm(skill, opts) {
      opts = opts || {}; this.state.editing = true; this.renderList();
      const d = document.getElementById('skMindDetail'); if (!d) return;
      const inp = 'background:var(--surface0);border:1px solid var(--surface2);border-radius:6px;color:var(--text);font-size:12.5px;padding:8px 10px;outline:none;width:100%;box-sizing:border-box;';
      d.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:9px;height:100%;">' +
          (opts.accept ? '<div style="font-size:11px;color:var(--yellow);">Reviewing a proposed skill -- edit then Accept to add it to the corpus.</div>' : '') +
          '<input id="skmName" placeholder="Skill name (imperative)" value="' + escapeHtml(skill.name || '') + '" style="' + inp + '">' +
          '<input id="skmId" placeholder="id (kebab-case; blank = from name)" value="' + escapeHtml(skill.id || '') + '" ' + (skill.id && !opts.accept ? 'readonly' : '') + ' style="' + inp + (skill.id && !opts.accept ? 'opacity:.6;' : '') + '">' +
          '<input id="skmDesc" placeholder="One-line description: what it does + when to use it" value="' + escapeHtml(skill.description || '') + '" style="' + inp + '">' +
          '<input id="skmWhen" placeholder="when: short trigger phrase (optional)" value="' + escapeHtml(skill.when || '') + '" style="' + inp + '">' +
          '<input id="skmTags" placeholder="tags, comma, separated" value="' + escapeHtml((skill.tags || []).join(', ')) + '" style="' + inp + '">' +
          '<textarea id="skmBody" placeholder="Body markdown: ## Use when / ## Steps (primary path) / ## Safety / ## Verification" style="' + inp + 'flex:1;min-height:240px;font-family:var(--font-mono,monospace);line-height:1.5;resize:none;">' + escapeHtml(skill.body || '') + '</textarea>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button class="tab-bar-btn" onclick="MindSkills.cancel()">Cancel</button>' +
            '<button style="font-size:12px;padding:7px 16px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:600;cursor:pointer;" onclick="MindSkills.save(' + (opts.accept ? '\'' + escapeHtml(skill.id) + '\'' : 'null') + ')">' + (opts.accept ? 'Accept' : 'Save') + '</button>' +
          '</div>' +
        '</div>';
    },
    cancel() { this.state.editing = false; if (this.state.selectedId) this.select(this.state.selectedId); else { this.renderList(); this.detailEmpty(); } },
    async save(acceptId) {
      const g = (id) => (document.getElementById(id) || {}).value || '';
      const name = g('skmName').trim();
      const id = (g('skmId').trim() || name);
      const description = g('skmDesc').trim();
      const when = g('skmWhen').trim();
      const tags = g('skmTags').split(',').map(s => s.trim()).filter(Boolean);
      const body = g('skmBody');
      if (!name || !description || !body.trim()) { _toast('Name, description and body are required', 'error'); return; }
      const r = await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, description, when, tags, body }) }).then(x => x.json()).catch(() => ({}));
      if (!r.ok) { _toast('Save failed: ' + (r.error || ''), 'error'); return; }
      if (acceptId) { try { await fetch('/api/skills/proposals/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: acceptId }) }); } catch (_) {} }
      this.state.editing = false; this.state.selectedId = r.id; _toast('Skill saved', 'success'); this.load();
    },
    async del(id) {
      if (!confirm('Delete the skill "' + id + '"?')) return;
      await fetch('/api/skills/item?id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
      this.state.selectedId = null; this.state.current = null; _toast('Skill deleted', 'success'); this.load();
    },
    async accept(id) {
      const r = await fetch('/api/skills/proposals/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(x => x.json()).catch(() => ({}));
      if (r.ok) { this.state.selectedId = r.id; _toast('Proposal accepted -- now a skill every CLI inherits', 'success'); } else _toast('Accept failed', 'error');
      this.load();
    },
    async reject(id) { await fetch('/api/skills/proposals/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {}); this.load(); },
    async reflect() {
      _toast('Reflecting on Mind corrections...', 'info');
      const r = await fetch('/api/skills/reflect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json()).catch(() => ({}));
      _toast(r && r.proposals ? (r.proposals.length + ' new proposal(s)') : 'Nothing new to propose', 'success');
      this.load();
    },
  };
  window.MindSkills = MindSkills;
  function renderSkills() { MindSkills.render(); }

  // ── Unified Search view (replaces both Query and Smart search) ──────────
  // Single tab. Auto-uses hybrid (BM25 + dense) when vectors are loaded;
  // falls back to BM25-only otherwise. Shows score badges per result so
  // the user sees why each result ranked.

export { MindSkills, renderSkills };
