// ── Activity Timeline ───────────────────────────────────────────────────
state._tlRangeDays = 5;
function openActivityTimeline() {
  openPopupTab('activityTabBtn');
  renderTimeline();
  lucide.createIcons();
}
function closeActivityTimeline() {
  closePopupTab('activityTabBtn');
}
function setTimelineRange(days, btn) {
  state._tlRangeDays = days;
  document.querySelectorAll('.tl-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderTimeline();
}
function getTimelineItems() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - state._tlRangeDays);
  return [...state.workItems].filter(wi => new Date(wi.changedDate) >= cutoff).sort((a, b) => new Date(b.changedDate) - new Date(a.changedDate));
}
function entryMeta(wi) {
  const state = wi.state;
  if (state === 'Closed' || state === 'Done') return {
    text: 'Closed',
    color: 'var(--subtext0)',
    bg: 'var(--surface0)',
    icon: 'check-circle'
  };
  if (state === 'Resolved') return {
    text: 'Resolved',
    color: 'var(--mauve)',
    bg: 'rgba(203,166,247,0.1)',
    icon: 'check'
  };
  if (state === 'Active') return {
    text: 'In Progress',
    color: 'var(--green)',
    bg: 'rgba(166,227,161,0.1)',
    icon: 'play'
  };
  if (state === 'New') {
    const created = wi.createdDate ? new Date(wi.createdDate) : null;
    const changed = new Date(wi.changedDate);
    if (created && Math.abs(changed - created) < 120000) return {
      text: 'Created',
      color: 'var(--blue)',
      bg: 'rgba(137,180,250,0.1)',
      icon: 'plus-circle'
    };
    return {
      text: 'Updated',
      color: 'var(--sapphire)',
      bg: 'rgba(116,199,236,0.1)',
      icon: 'edit'
    };
  }
  return {
    text: state,
    color: 'var(--subtext0)',
    bg: 'var(--surface0)',
    icon: 'circle'
  };
}
function renderTimelineCharts(items) {
  const charts = document.getElementById('timelineCharts');

  // Count by current state
  const stateCounts = {
    'In Progress': 0,
    'Resolved': 0,
    'Created': 0,
    'Closed': 0,
    'Updated': 0
  };
  for (const wi of items) {
    const m = entryMeta(wi);
    if (stateCounts[m.text] !== undefined) stateCounts[m.text]++;
  }
  const maxState = Math.max(1, ...Object.values(stateCounts));
  const stateColors = {
    'In Progress': 'var(--green)',
    'Resolved': 'var(--mauve)',
    'Created': 'var(--blue)',
    'Closed': 'var(--subtext0)',
    'Updated': 'var(--sapphire)'
  };

  // Daily activity counts (one bar per day)
  const dailyCounts = {};
  for (let i = state._tlRangeDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dailyCounts[d.toDateString()] = {
      label: d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      }),
      count: 0
    };
  }
  for (const wi of items) {
    const key = new Date(wi.changedDate).toDateString();
    if (dailyCounts[key]) dailyCounts[key].count++;
  }
  const maxDaily = Math.max(1, ...Object.values(dailyCounts).map(d => d.count));
  let html = '<div class="tl-charts">';

  // Card 1: Status breakdown (horizontal bars)
  html += '<div class="tl-chart-card">';
  html += '<div class="tl-chart-title">Activity by Status</div>';
  for (const [label, count] of Object.entries(stateCounts)) {
    if (count === 0) continue;
    const pct = count / maxState * 100;
    html += `<div class="tl-stat-row">
      <span class="tl-stat-label">${label}</span>
      <div class="tl-stat-bar-bg"><div class="tl-stat-bar" style="width:${pct}%;background:${stateColors[label] || 'var(--accent)'}"></div></div>
      <span class="tl-stat-count">${count}</span>
    </div>`;
  }
  html += '</div>';

  // Card 2: Daily activity (vertical bars)
  html += '<div class="tl-chart-card">';
  html += '<div class="tl-chart-title">Daily Activity</div>';
  html += '<div class="tl-daily-chart">';
  for (const [, day] of Object.entries(dailyCounts)) {
    const pct = day.count / maxDaily * 100;
    html += `<div class="tl-daily-col">
      <div class="tl-daily-bar" style="height:${Math.max(3, pct)}%;background:var(--accent);"></div>
      <div class="tl-daily-label">${day.label}</div>
    </div>`;
  }
  html += '</div></div>';
  html += '</div>';
  charts.innerHTML = html;
}
function renderTimeline() {
  const items = getTimelineItems();
  renderTimelineCharts(items);
  const container = document.getElementById('timelineContent');
  if (items.length === 0) {
    container.innerHTML = '<div class="cmd-palette-empty">No activity in the last ' + state._tlRangeDays + ' days</div>';
    return;
  }

  // Group by day
  const groups = {};
  for (const wi of items) {
    const d = new Date(wi.changedDate);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    let dayKey;
    if (d.toDateString() === today.toDateString()) dayKey = 'Today';else if (d.toDateString() === yesterday.toDateString()) dayKey = 'Yesterday';else dayKey = d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    if (!groups[dayKey]) groups[dayKey] = [];
    groups[dayKey].push(wi);
  }
  let html = '';
  for (const [day, dayItems] of Object.entries(groups)) {
    html += `<div class="timeline-day">`;
    html += `<div class="timeline-day-label">${day} <span style="font-weight:400;color:var(--overlay0);">(${dayItems.length})</span></div>`;
    for (const wi of dayItems) {
      const m = entryMeta(wi);
      const time = new Date(wi.changedDate).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      });
      html += `
        <div class="timeline-entry" onclick="viewWorkItem(${wi.id})">
          <div class="timeline-icon" style="background:${m.bg};color:${m.color};">
            <i data-lucide="${m.icon}"></i>
          </div>
          <div style="flex:1;min-width:0;">
            <div class="timeline-entry-title">
              <span class="timeline-entry-id">#${wi.id}</span> ${esc(wi.title)}
            </div>
            <div class="timeline-entry-meta">
              <span style="color:${m.color};font-weight:600;">${m.text}</span>
              ${wi.assignedTo ? ` · ${esc(wi.assignedTo.split('<')[0].trim())}` : ''}
              · ${time}
              ${wi.type ? ` · ${wi.type}` : ''}
              ${wi.storyPoints ? ` · ${wi.storyPoints} pts` : ''}
            </div>
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  container.innerHTML = html;
  lucide.createIcons();
}