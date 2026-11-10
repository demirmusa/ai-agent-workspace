/* AIWS example plugin: browser side.
 *
 * This file is an ES module. When the plugin is enabled, AIWS calls activate(aiws); `aiws` is the API object that belongs
 * to this plugin. Everything registered here (menu, page, tab, section, badge, command, listener) is removed by AIWS
 * automatically when the plugin is turned off. The whole API: src/assets/agent-skills/aiws-plugin-development
 *
 * The plugin's data on a task is stored under `task.pluginData["aiws.example"]`:
 *   { estimate: 3, risk: "medium", criteria: [{ text: "Tests pass", done: false }] }
 */

const STATUS_ORDER = ['backlog', 'ready', 'running', 'waiting', 'review', 'done', 'failed'];
const STATUS_LABELS = { backlog: 'Bekleyen', ready: 'Hazır', running: 'Çalışıyor', waiting: 'Yanıt bekliyor', review: 'İnceleme', done: 'Tamamlandı', failed: 'Başarısız' };
const RISKS = { low: { label: 'Düşük risk', tone: 'done' }, medium: { label: 'Orta risk', tone: 'needs' }, high: { label: 'Yüksek risk', tone: 'failed' } };

export function activate(aiws) {
  const { ui, i18n } = aiws;

  // The plugin's own strings: the source is Turkish (the app's source language); i18n.t() translates them in the English UI.
  i18n.add({ en: {
    'Görev istatistikleri': 'Task statistics', 'Tüm projelerdeki görevlerin durumu ve toplam tahmin': 'Status of tasks in all projects and the total estimate',
    'Bekleyen': 'Backlog', 'Hazır': 'Ready', 'Çalışıyor': 'Running', 'Yanıt bekliyor': 'Waiting', 'İnceleme': 'Review', 'Tamamlandı': 'Done', 'Başarısız': 'Failed',
    'Toplam görev': 'Total tasks', 'Toplam tahmin': 'Total estimate', 'Tahminli görev': 'Estimated tasks', 'Projeler': 'Projects', 'Sunucu yanıtı': 'Server response',
    'Sunucu kodu kapalı': 'Server code is off', 'Not ekle': 'Add note', 'Hızlı not': 'Quick note', 'Not': 'Note', 'Not kaydedildi': 'Note saved',
    'Notlar': 'Notes', 'Bu projenin notları': 'Notes for this project', 'Kaydet': 'Save', 'Henüz not yok.': 'No notes yet.', 'Sil': 'Delete',
    'Tahmin ve kabul kriterleri': 'Estimate and acceptance criteria', 'Tahmin': 'Estimate', 'Kabul kriterleri': 'Acceptance criteria',
    'Her satır bir kriter': 'One criterion per line', 'Tahmin 0 ile 100 arasında olmalı.': 'The estimate must be between 0 and 100.',
    'Risk': 'Risk', 'Risk seviyesi': 'Risk level', 'Belirtilmedi': 'Not set', 'Düşük risk': 'Low risk', 'Orta risk': 'Medium risk', 'Yüksek risk': 'High risk',
    'Planlama': 'Planning', 'Kontrol listesi': 'Checklist', 'Kriter yok. Görevi düzenleyip kabul kriterleri ekle.': 'No criteria. Edit the task to add acceptance criteria.',
    'tamamlandı': 'done', 'Kaydediliyor…': 'Saving…', 'Özeti kopyala': 'Copy summary', 'Özet panoya kopyalandı': 'Summary copied to the clipboard',
    'Görev tamamlandı': 'Task done', 'Bağlantıyı dene': 'Test connection', 'Vurgu': 'Highlight', 'Ayarlardaki vurgu rengiyle oluşturulur': 'Built from the highlight colour in settings',
  } });
  const t = i18n.t;
  const unit = () => aiws.settings.get('pointUnit') || 'SP';
  const dataOf = task => task?.pluginData?.[aiws.plugin.id] || {};
  const highlightStyle = () => `--hx-highlight:${aiws.settings.get('highlight') || '#7c5cff'}`;

  // ── 1. Sidebar item and full-page screen ─────────────────────────────────────────────────────────────────────────
  const openTasks = () => aiws.state().tasks.filter(task => !task.archivedAt && !['done', 'cancelled'].includes(task.status)).length;
  aiws.sidebar.addItem({ id: 'stats', label: t('Görev istatistikleri'), icon: 'check', page: 'stats', badge: () => openTasks(), order: 10 });

  aiws.pages.register({
    id: 'stats',
    title: t('Görev istatistikleri'),
    summary: t('Tüm projelerdeki görevlerin durumu ve toplam tahmin'),
    render(container) {
      const draw = () => {
        const tasks = aiws.state().tasks.filter(task => !task.archivedAt && !task.sessionContinuation);
        const counts = Object.fromEntries(STATUS_ORDER.map(status => [status, tasks.filter(task => task.status === status).length]));
        const estimated = tasks.filter(task => Number.isFinite(dataOf(task).estimate));
        const total = estimated.reduce((sum, task) => sum + dataOf(task).estimate, 0);
        const max = Math.max(1, ...Object.values(counts));
        container.innerHTML = ui.html`<div class="hx-page" style="${highlightStyle()}">
          <div class="hx-stats">
            <div class="hx-stat"><small>${t('Toplam görev')}</small><strong>${tasks.length}</strong></div>
            <div class="hx-stat"><small>${t('Toplam tahmin')}</small><strong>${total} ${unit()}</strong></div>
            <div class="hx-stat"><small>${t('Tahminli görev')}</small><strong>${estimated.length}</strong></div>
            <div class="hx-stat"><small>${t('Projeler')}</small><strong>${aiws.state().projects.length}</strong></div>
          </div>
          <div class="hx-bars">${ui.raw(STATUS_ORDER.map(status => ui.html`<div class="hx-bar-row"><span>${t(STATUS_LABELS[status])}</span><div class="hx-bar"><i style="width:${Math.round(counts[status] / max * 100)}%"></i></div><b>${counts[status]}</b></div>`).join(''))}</div>
          <p class="hx-server" data-hx-server>${t('Sunucu yanıtı')}: …</p>
        </div>`;
        // The plugin's own server route: routes.get('/stats') in server.js.
        aiws.http.route('stats').then(result => {
          const line = container.querySelector('[data-hx-server]');
          if (line) line.textContent = `${t('Sunucu yanıtı')}: ${result.tasks} · ${result.estimate} ${unit()} · ${result.generatedAt}`;
        }).catch(() => { const line = container.querySelector('[data-hx-server]'); if (line) line.textContent = t('Sunucu kodu kapalı'); });
      };
      draw();
      // update() is called on every render (for example when new state arrives); here we redraw the whole page.
      return { update: draw };
    },
  });

  // ── 2. Header button and modal ───────────────────────────────────────────────────────────────────────────────────
  aiws.topbar.addButton({
    id: 'quick-note', label: t('Hızlı not'), icon: 'pin', title: t('Not ekle'),
    visible: ctx => Boolean(ctx.project),
    onClick: ctx => ui.modal({
      title: t('Hızlı not'),
      body: ui.html`<div class="form-field"><label for="hx-note">${t('Not')}</label><textarea id="hx-note" name="note" rows="4" required></textarea></div>`,
      submitLabel: t('Kaydet'),
      async onSubmit(data) {
        const key = `notes:${ctx.project.id}`, notes = (await aiws.storage.get(key)) || [];
        notes.unshift({ text: String(data.get('note')), at: new Date().toISOString() });
        await aiws.storage.set(key, notes.slice(0, 100));
        ui.toast(t('Not kaydedildi'));
        ui.render();
      },
    }),
  });

  // ── 3. Project tab (next to Board · Terminal · ...) ──────────────────────────────────────────────────────────────
  aiws.projectTabs.add({
    id: 'notes', label: t('Notlar'),
    render(container, ctx) {
      let projectId = null;
      const draw = async project => {
        projectId = project?.id;
        const notes = projectId ? (await aiws.storage.get(`notes:${projectId}`)) || [] : [];
        if (project?.id !== projectId) return;
        container.innerHTML = ui.html`<div class="hx-page"><h2 class="hx-title">${t('Bu projenin notları')}</h2>
          <div class="hx-note-form"><textarea data-hx-new rows="3" placeholder="${t('Not')}"></textarea><button type="button" class="button small primary" data-hx-add>${t('Kaydet')}</button></div>
          <ul class="hx-notes">${ui.raw(notes.map((note, index) => ui.html`<li><p>${note.text}</p><small>${new Date(note.at).toLocaleString(i18n.locale)}</small><button type="button" class="button small ghost" data-hx-delete="${index}">${t('Sil')}</button></li>`).join('') || ui.html`<li class="hx-empty">${t('Henüz not yok.')}</li>`)}</ul></div>`;
      };
      container.addEventListener('click', async event => {
        const key = `notes:${projectId}`;
        if (event.target.closest('[data-hx-add]')) {
          const text = container.querySelector('[data-hx-new]').value.trim(); if (!text) return;
          await aiws.storage.set(key, [{ text, at: new Date().toISOString() }, ...((await aiws.storage.get(key)) || [])].slice(0, 100));
          await draw(aiws.project());
        }
        const remove = event.target.closest('[data-hx-delete]');
        if (remove) { const notes = (await aiws.storage.get(key)) || []; notes.splice(Number(remove.dataset.hxDelete), 1); await aiws.storage.set(key, notes); await draw(aiws.project()); }
      });
      void draw(ctx.project);
      // The tab is redrawn when the project changes; within the same project update() does nothing, so a typed note is kept.
      return { update: next => { if (next.project?.id !== projectId) void draw(next.project); } };
    },
  });

  // ── 4. Task create/edit window ───────────────────────────────────────────────────────────────────────────────────
  // placement: 'main' → a section below the description that is always visible.
  aiws.taskForm.addSection({
    id: 'estimate', title: t('Tahmin ve kabul kriterleri'), placement: 'main',
    render(container, ctx) {
      container.innerHTML = ui.html`<div class="form-grid hx-form"><div class="form-field"><label for="hx-estimate">${t('Tahmin')} (${unit()})</label><input id="hx-estimate" type="number" min="0" max="100" step="0.5" value="${ctx.data.estimate ?? ''}"></div>
        <div class="form-field"><label for="hx-criteria">${t('Kabul kriterleri')}</label><textarea id="hx-criteria" rows="3" placeholder="${t('Her satır bir kriter')}">${(ctx.data.criteria || []).map(item => item.text).join('\n')}</textarea></div></div>`;
      return {
        validate() { const value = container.querySelector('#hx-estimate').value; if (value !== '' && (Number(value) < 0 || Number(value) > 100)) return t('Tahmin 0 ile 100 arasında olmalı.'); return null; },
        // collect() is merged into this plugin's task data (together with the data of the other sections).
        collect() {
          const value = container.querySelector('#hx-estimate').value, previous = ctx.data.criteria || [];
          const criteria = container.querySelector('#hx-criteria').value.split('\n').map(line => line.trim()).filter(Boolean).map(text => ({ text, done: previous.find(item => item.text === text)?.done || false }));
          return { estimate: value === '' ? null : Number(value), criteria };
        },
      };
    },
  });
  // placement: 'tab' (default) → a new tab under "Advanced options".
  aiws.taskForm.addSection({
    id: 'risk', title: t('Risk'),
    render(container, ctx) {
      container.innerHTML = ui.html`<div class="form-field"><label for="hx-risk">${t('Risk seviyesi')}</label><select id="hx-risk"><option value="">${t('Belirtilmedi')}</option>${ui.raw(Object.entries(RISKS).map(([value, risk]) => ui.html`<option value="${value}" ${ctx.data.risk === value ? 'selected' : ''}>${t(risk.label)}</option>`).join(''))}</select></div>`;
      return { collect: () => ({ risk: container.querySelector('#hx-risk').value || null }) };
    },
  });

  // ── 5. Task detail panel ─────────────────────────────────────────────────────────────────────────────────────────
  // A panel in the right column of the Information tab; values are saved immediately with ctx.saveData().
  aiws.taskDetail.addSection({
    id: 'planning', title: t('Planlama'), placement: 'sidebar',
    render(container, ctx) {
      const draw = current => {
        const data = current.data;
        container.innerHTML = ui.html`<dl class="issue-fields hx-detail"><div class="issue-field"><dt>${t('Tahmin')}</dt><dd>${data.estimate ?? '—'} ${data.estimate == null ? '' : unit()}</dd></div>
          <div class="issue-field"><dt>${t('Risk')}</dt><dd><select data-hx-risk><option value="">${t('Belirtilmedi')}</option>${ui.raw(Object.entries(RISKS).map(([value, risk]) => ui.html`<option value="${value}" ${data.risk === value ? 'selected' : ''}>${t(risk.label)}</option>`).join(''))}</select></dd></div></dl>`;
        container.querySelector('[data-hx-risk]').onchange = event => current.saveData({ ...current.data, risk: event.target.value || null });
      };
      draw(ctx);
      return { update: draw };
    },
  });
  // A new tab in the detail panel (next to Information · Chat · Agent Console).
  aiws.taskDetail.addTab({
    id: 'checklist', label: t('Kontrol listesi'),
    render(container, ctx) {
      let current = ctx;
      const draw = () => {
        const criteria = current.data.criteria || [];
        container.innerHTML = criteria.length
          ? ui.html`<div class="hx-page"><p class="form-hint">${criteria.filter(item => item.done).length}/${criteria.length} ${t('tamamlandı')}</p><ul class="hx-checklist">${ui.raw(criteria.map((item, index) => ui.html`<li><label class="checkbox-field"><input type="checkbox" data-hx-check="${index}" ${item.done ? 'checked' : ''}> ${item.text}</label></li>`).join(''))}</ul></div>`
          : ui.html`<p class="hx-empty">${t('Kriter yok. Görevi düzenleyip kabul kriterleri ekle.')}</p>`;
      };
      container.addEventListener('change', event => {
        const index = event.target.dataset.hxCheck; if (index === undefined) return;
        const criteria = (current.data.criteria || []).map((item, at) => at === Number(index) ? { ...item, done: event.target.checked } : item);
        void current.saveData({ ...current.data, criteria });
      });
      draw();
      return { update: next => { current = next; draw(); } };
    },
  });
  // A task action in the "⋯" menu.
  aiws.taskDetail.addAction({
    id: 'copy-summary', label: t('Özeti kopyala'),
    async run(ctx) {
      const data = ctx.data, lines = [`# ${ctx.task.title}`, `${t('Tahmin')}: ${data.estimate ?? '—'} ${unit()}`, `${t('Risk')}: ${data.risk ? t(RISKS[data.risk].label) : t('Belirtilmedi')}`, ...(data.criteria || []).map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`)];
      await navigator.clipboard.writeText(lines.join('\n'));
      ui.toast(t('Özet panoya kopyalandı'));
    },
  });

  // ── 6. Task card badges ──────────────────────────────────────────────────────────────────────────────────────────
  aiws.taskCard.addBadge({
    id: 'estimate',
    render(task) {
      if (!aiws.settings.get('showBadges')) return null;
      const data = dataOf(task), badges = [];
      if (Number.isFinite(data.estimate)) badges.push({ text: `${data.estimate} ${unit()}`, tone: 'accent', title: t('Tahmin') });
      if (data.risk) badges.push({ text: t(RISKS[data.risk].label), tone: RISKS[data.risk].tone });
      if (data.criteria?.length) badges.push({ text: `☑ ${data.criteria.filter(item => item.done).length}/${data.criteria.length}`, title: t('Kabul kriterleri') });
      return badges;
    },
  });

  // ── 7. Command and shortcut ──────────────────────────────────────────────────────────────────────────────────────
  aiws.commands.register({ id: 'open-stats', title: t('Görev istatistikleri'), shortcut: 'Ctrl+Shift+Y', run: () => aiws.navigate.page('stats') });

  // ── 8. Events ────────────────────────────────────────────────────────────────────────────────────────────────────
  aiws.events.on('task:statusChanged', ({ task, to }) => { if (to === 'done' && aiws.settings.get('celebrate')) ui.toast(`🎉 ${t('Görev tamamlandı')}: ${task.title}`); });
  // Cards and the theme are redrawn when a setting changes.
  aiws.settings.onChange(() => { registerHighlightTheme(); ui.render(); });

  // ── 9. Runtime theme: built from the color in settings ───────────────────────────────────────────────────────────
  let disposeTheme = null;
  function registerHighlightTheme() {
    disposeTheme?.();
    const color = aiws.settings.get('highlight') || '#7c5cff';
    disposeTheme = aiws.themes.register({ id: 'highlight', name: t('Vurgu'), description: t('Ayarlardaki vurgu rengiyle oluşturulur'), dark: { accent: color, link: color, focus: color }, light: { accent: color, link: color, focus: color } });
  }
  registerHighlightTheme();

  // ── 10. Custom panel on the Settings → Plugins card ──────────────────────────────────────────────────────────────
  aiws.settings.addPanel({
    render(container) {
      container.innerHTML = ui.html`<div class="hx-ping"><button type="button" class="button small" data-hx-ping>${t('Bağlantıyı dene')}</button><code data-hx-ping-result></code></div>`;
      container.querySelector('[data-hx-ping]').onclick = async () => {
        const output = container.querySelector('[data-hx-ping-result]');
        try { output.textContent = JSON.stringify(await aiws.http.route('ping')); } catch (error) { output.textContent = error.message; }
      };
    },
  });

  // activate may return a cleanup function; what was registered is removed automatically anyway.
  return () => disposeTheme?.();
}
