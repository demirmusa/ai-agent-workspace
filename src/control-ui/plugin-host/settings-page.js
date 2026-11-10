/* Settings → Eklentiler: the plugin skill, installation, theme choice and one card per installed plugin with its settings and logs. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit, host = kit.host, { ui, i18n, t, esc, plugins, registry, views, panelState, localized, entries, domId, withData, mountView, unmountView, appContext, api } = kit;
  // ── Settings → Plugins page.
  async function loadSkillStatus() { try { host.skillStatus = await api('/plugin-skill'); } catch (error) { host.skillStatus = { error: error.message }; } }
  function settingField(info, field) {
    const id = `plugin-setting-${domId(info.id)}-${domId(field.key)}`, value = info.settings?.[field.key], label = esc(localized(field.label)), help = field.description ? `<small>${esc(localized(field.description))}</small>` : '';
    const common = `id="${id}" data-plugin-setting="${esc(field.key)}" data-plugin-id="${esc(info.id)}"`, placeholder = field.placeholder ? ` placeholder="${esc(localized(field.placeholder))}"` : '';
    if (field.type === 'boolean') return `<div class="settings-switch-row plugin-setting-row"><div class="settings-row-text"><label for="${id}">${label}</label>${help}</div><input type="checkbox" class="ui-switch" role="switch" ${common} ${value ? 'checked' : ''}></div>`;
    if (field.type === 'select') return `<div class="form-field"><label for="${id}">${label}</label><select ${common}>${field.options.map(option => `<option value="${esc(option.value)}" ${option.value === value ? 'selected' : ''}>${esc(localized(option.label))}</option>`).join('')}</select>${help}</div>`;
    if (field.type === 'textarea') return `<div class="form-field"><label for="${id}">${label}</label><textarea rows="4" ${common}${placeholder}>${esc(value ?? '')}</textarea>${help}</div>`;
    const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : field.type === 'color' ? 'color' : 'text';
    return `<div class="form-field"><label for="${id}">${label}</label><input type="${type}" ${common}${placeholder} value="${esc(value ?? '')}"${field.min !== undefined ? ` min="${esc(field.min)}"` : ''}${field.max !== undefined ? ` max="${esc(field.max)}"` : ''} autocomplete="off">${help}</div>`;
  }
  function contributionSummary(id) {
    const counts = [['sidebar', 'Menü'], ['topbar', 'Üst buton'], ['pages', 'Sayfa'], ['projectTabs', 'Proje sekmesi'], ['taskForm', 'Görev formu bölümü'], ['taskDetail', 'Detay bölümü'], ['taskDetailTabs', 'Detay sekmesi'], ['taskActions', 'Görev işlemi'], ['cardBadges', 'Kart rozeti'], ['commands', 'Komut'], ['themes', 'Tema']]
      .map(([kind, label]) => [[...registry[kind].values()].filter(entry => entry.plugin.id === id).length, label]).filter(([count]) => count);
    return counts.map(([count, label]) => `${t(label)}: ${count}`).join(' · ');
  }
  function swatches(def) { const tokens = { ...(def.light || {}), ...(def.dark || {}) }; return ['ground', 'surface', 'raised', 'accent', 'ink'].map(name => tokens[name] ? `<i style="background:${esc(String(tokens[name]).replace(/[;{}<>]/g, ''))}"></i>` : '<i class="is-default"></i>').join(''); }
  function themeCard() {
    const active = kit.activeThemeKey(), themes = kit.themeEntries();
    const option = (value, name, description, preview) => `<label class="plugin-theme-option${value === active ? ' is-active' : ''}"><input type="radio" name="plugin-theme-choice" value="${esc(value)}" ${value === active ? 'checked' : ''} data-plugin-theme-choice><span class="plugin-theme-swatches" aria-hidden="true">${preview}</span><span class="plugin-theme-text"><strong>${esc(name)}</strong><small>${esc(description)}</small></span></label>`;
    return `<div class="settings-card plugin-theme-card"><h3 class="plugin-card-title">${esc(t('Tema'))}</h3><p class="form-hint">${esc(t('Eklentilerin getirdiği temalar renkleri değiştirir. Kenar çubuğundaki açık/koyu düğmesi seçili temanın modunu değiştirir.'))}</p><div class="plugin-theme-options" role="radiogroup" aria-label="${esc(t('Tema'))}">${option('', t('Varsayılan'), t('AIWS’ın yerleşik açık ve koyu teması'), '<i class="is-default"></i><i class="is-default"></i><i class="is-default"></i>')}${themes.map(theme => option(theme.key, localized(theme.def.name), `${localized(theme.def.description || '')}${theme.def.description ? ' · ' : ''}${localized(theme.plugin.info.manifest?.name || theme.plugin.id)}`, swatches(theme.def))).join('')}</div>${themes.length ? '' : `<p class="form-hint">${esc(t('Henüz tema yok. Tema içeren bir eklenti kurduğunda burada görünür.'))}</p>`}</div>`;
  }
  function skillCard() {
    const status = host.skillStatus, installed = status?.installed, modified = status?.modified;
    const state = !status ? t('Durum kontrol ediliyor…') : status.error ? status.error : installed ? t('Yüklü · Codex ve Claude Code bu skill ile eklenti geliştirebilir.') : modified ? t('Yüklü ama yerel olarak değiştirilmiş.') : t('Yüklü değil.');
    return `<div class="settings-card plugin-skill-card"><div class="plugin-skill-head"><span class="ui-icon-box" aria-hidden="true">${ui.sparkle('accent')}</span><div><h3 class="plugin-card-title">${esc(t('Eklenti geliştirme skill’i'))}</h3><p class="form-hint">${esc(t('aiws-plugin-development skill’i agentlara eklenti sistemini, tüm API’yi ve örnekleri öğretir. Yüklediğinde Codex (~/.agents/skills) ve Claude Code (~/.claude/skills) kullanıcı skill’lerine kopyalanır; varsayılan olarak yüklenmez.'))}</p></div></div><div class="plugin-skill-actions"><span class="plugin-skill-status" role="status" data-state="${installed ? 'done' : modified ? 'needs' : 'idle'}">${esc(state)}</span><button type="button" class="button small primary${host.skillBusy ? ' is-busy' : ''}" data-plugin-skill-install ${host.skillBusy ? 'disabled' : ''}>${esc(installed ? t('Skill’i yeniden yükle') : t('Skill’i yükle'))}</button>${modified ? `<button type="button" class="button small" data-plugin-skill-install data-force="true" ${host.skillBusy ? 'disabled' : ''}>${esc(t('Değişikliklerin üzerine yaz'))}</button>` : ''}</div>${status?.targets?.length ? `<ul class="plugin-skill-targets">${status.targets.map(target => `<li><code>${esc(target.path)}</code></li>`).join('')}</ul>` : ''}</div>`;
  }
  function installCard() {
    return `<div class="settings-card plugin-install-card"><h3 class="plugin-card-title">${esc(t('Eklenti kur'))}</h3><p class="form-hint">${esc(t('plugin.json içeren bir klasör veya ZIP dosyası seç. Klasör kopyalanarak kurulur; geliştirici modunda kopyalanmaz, klasöre bağlanır ve değişiklikler yeniden yüklemede görünür.'))}</p><div class="plugin-install-row"><label class="sr-only" for="plugin-install-path">${esc(t('Eklenti klasörü'))}</label><input id="plugin-install-path" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(t('Eklenti klasörünün tam yolu'))}">${global.aiwsDesktop?.chooseDirectory ? `<button type="button" class="button small" data-plugin-choose-folder>${esc(t('Klasör seç…'))}</button>` : ''}<button type="button" class="button small primary${panelState.installBusy ? ' is-busy' : ''}" data-plugin-install-folder ${panelState.installBusy ? 'disabled' : ''}>${esc(t('Klasörden kur'))}</button></div><div class="plugin-install-row"><label class="checkbox-field plugin-link-mode"><input type="checkbox" id="plugin-install-link"> ${esc(t('Geliştirici modu: klasörü kopyalamadan bağla'))}</label><span class="plugin-install-spacer"></span><label class="button small plugin-zip-button"><input type="file" accept=".zip,application/zip" data-plugin-install-zip class="sr-only">${esc(t('ZIP dosyası yükle'))}</label><button type="button" class="button small ghost" data-plugin-rescan>${esc(t('Yeniden tara'))}</button></div><p class="form-error" role="alert">${esc(panelState.installError)}</p><p class="form-hint plugin-directory">${esc(t('Kurulum klasörü'))}: <code>${esc(host.catalogDirectory)}</code></p></div>`;
  }
  function pluginCard(info) {
    const manifest = info.manifest, plugin = plugins.get(info.id), open = panelState.open.has(info.id), busy = panelState.busy.has(info.id), errors = plugin?.errors || [];
    const name = manifest ? localized(manifest.name) : info.id, logs = panelState.logs.get(info.id);
    const badges = [manifest ? `<span class="ui-chip is-mono">v${esc(manifest.version)}</span>` : '', info.mode === 'bundled' ? `<span class="ui-chip">${esc(t('Yerleşik'))}</span>` : '', info.mode === 'link' ? `<span class="ui-chip is-accent" title="${esc(info.directory)}">${esc(t('Geliştirici bağlantısı'))}</span>` : '', manifest?.server ? `<span class="ui-chip" data-tone="needs" title="${esc(t('Bu eklenti kontrol sunucusunda Node.js kodu çalıştırır.'))}">${esc(info.server.status === 'active' ? t('Sunucu kodu çalışıyor') : info.server.status === 'error' ? t('Sunucu kodu hatalı') : t('Sunucu kodu kapalı'))}</span>` : '', info.error || errors.length || info.server.error ? `<span class="ui-chip" data-tone="failed">${esc(t('Hata'))}</span>` : ''].join('');
    const icon = manifest?.icon ? `<img src="${esc(info.assetBase + manifest.icon)}" alt="" width="20" height="20">` : ui.icon('plug');
    const settings = manifest?.settings?.length ? `<div class="plugin-settings-fields">${manifest.settings.map(field => settingField(info, field)).join('')}</div><div class="plugin-settings-actions"><button type="button" class="button small primary" data-plugin-save-settings="${esc(info.id)}" ${busy ? 'disabled' : ''}>${esc(t('Ayarları kaydet'))}</button></div>` : '';
    const panels = entries('settingsPanels').filter(entry => entry.plugin.id === info.id).length ? `<div class="plugin-custom-settings" data-plugin-settings-panel="${esc(info.id)}"></div>` : '';
    const problems = [info.error, info.server.error, ...errors.slice(-5).map(item => item.message)].filter(Boolean);
    const details = open ? `<div class="plugin-card-details">${problems.length ? `<ul class="plugin-errors">${problems.map(problem => `<li>${esc(problem)}</li>`).join('')}</ul>` : ''}<dl class="plugin-meta"><dt>${esc(t('Kimlik'))}</dt><dd><code>${esc(info.id)}</code></dd><dt>${esc(t('Klasör'))}</dt><dd><code>${esc(info.directory)}</code></dd>${manifest?.author ? `<dt>${esc(t('Geliştirici'))}</dt><dd>${esc(manifest.author)}</dd>` : ''}${/^https?:\/\//i.test(manifest?.homepage || '') ? `<dt>${esc(t('Ana sayfa'))}</dt><dd><a href="${esc(manifest.homepage)}" target="_blank" rel="noopener noreferrer">${esc(manifest.homepage)}</a></dd>` : ''}${info.server.routes.length ? `<dt>${esc(t('API rotaları'))}</dt><dd>${info.server.routes.map(route => `<code>${esc(route)}</code>`).join(' ')}</dd>` : ''}${plugin?.active ? `<dt>${esc(t('Katkılar'))}</dt><dd>${esc(contributionSummary(info.id) || t('Henüz kayıt yok'))}</dd>` : ''}</dl>${settings}${panels}${manifest?.server ? `<div class="plugin-logs"><button type="button" class="button small ghost" data-plugin-logs="${esc(info.id)}">${esc(t('Sunucu günlüklerini göster'))}</button>${logs ? `<pre class="plugin-log-list">${logs.length ? logs.map(entry => `<span data-level="${esc(entry.level)}">${esc(`${entry.at.slice(11, 19)} ${entry.level.toUpperCase()} ${entry.message}`)}</span>`).join('\n') : esc(t('Günlük boş.'))}</pre>` : ''}</div>` : ''}</div>` : '';
    return `<article class="settings-card plugin-card${info.enabled ? '' : ' is-disabled'}" data-plugin-card="${esc(info.id)}"><div class="plugin-card-head"><span class="ui-icon-box plugin-card-icon" aria-hidden="true">${icon}</span><div class="plugin-card-text"><div class="plugin-card-name"><strong>${esc(name)}</strong>${badges}</div><p class="form-hint">${esc(manifest ? localized(manifest.description || '') : info.error || '')}</p></div><input type="checkbox" class="ui-switch" role="switch" aria-label="${esc(`${name} · ${t('Etkin')}`)}" data-plugin-toggle="${esc(info.id)}" ${info.enabled ? 'checked' : ''} ${!manifest || busy ? 'disabled' : ''}></div><div class="plugin-card-actions"><button type="button" class="button small ghost" data-plugin-details="${esc(info.id)}" aria-expanded="${open}">${esc(open ? t('Ayrıntıları gizle') : manifest?.settings?.length ? t('Ayarlar ve ayrıntılar') : t('Ayrıntılar'))}</button><button type="button" class="button small ghost" data-plugin-kit.reload="${esc(info.id)}" ${busy || !info.enabled ? 'disabled' : ''}>${esc(t('Yeniden yükle'))}</button>${info.mode === 'bundled' ? '' : `<button type="button" class="button small ghost danger" data-plugin-uninstall="${esc(info.id)}" ${busy ? 'disabled' : ''}>${esc(info.mode === 'link' ? t('Bağlantıyı kaldır') : t('Kaldır'))}</button>`}</div>${details}</article>`;
  }
  function renderSettings(root) {
    if (!root) return;
    host.settingsHost = root;
    if (!host.catalogLoaded) { root.innerHTML = `<p class="form-hint">${esc(t('Eklentiler yükleniyor…'))}</p>`; void kit.loadCatalog().then(() => kit.sync()); return; }
    if (!host.skillStatus) void loadSkillStatus().then(() => { if (host.settingsHost?.isConnected) renderSettings(host.settingsHost); });
    const focused = root.contains(document.activeElement) ? document.activeElement : null, focusKey = focused ? (focused.id || focused.getAttribute('data-plugin-setting') && `${focused.dataset.pluginId}:${focused.dataset.pluginSetting}`) : '';
    const drafts = new Map([...root.querySelectorAll('[data-plugin-setting]')].map(input => [`${input.dataset.pluginId}:${input.dataset.pluginSetting}`, input.type === 'checkbox' ? input.checked : input.value]));
    const path = root.querySelector('#plugin-install-path')?.value || '', link = root.querySelector('#plugin-install-link')?.checked || false;
    for (const view of [...views.keys()]) if (root.contains(view)) unmountView(view);
    root.innerHTML = `${skillCard()}${installCard()}${themeCard()}<div class="plugin-list-head"><h3 class="plugin-card-title">${esc(t('Kurulu eklentiler'))}</h3><span class="nav-count">${host.catalog.length}</span></div>${host.catalogError ? `<p class="form-error">${esc(host.catalogError)}</p>` : ''}${host.catalog.length ? `<div class="plugin-list">${host.catalog.map(pluginCard).join('')}</div>` : `<div class="plugin-empty settings-card"><p>${esc(t('Henüz eklenti kurulu değil. Örnek eklentiyi examples/plugins klasöründen kurabilirsin.'))}</p></div>`}`;
    const pathInput = root.querySelector('#plugin-install-path'); if (pathInput) pathInput.value = path;
    const linkInput = root.querySelector('#plugin-install-link'); if (linkInput) linkInput.checked = link;
    for (const input of root.querySelectorAll('[data-plugin-setting]')) { const draft = drafts.get(`${input.dataset.pluginId}:${input.dataset.pluginSetting}`); if (draft !== undefined) { if (input.type === 'checkbox') input.checked = draft; else input.value = draft; } }
    for (const container of root.querySelectorAll('[data-plugin-settings-panel]')) {
      for (const entry of entries('settingsPanels').filter(item => item.plugin.id === container.dataset.pluginSettingsPanel)) {
        const body = document.createElement('div'); container.append(body);
        mountView(body, `settings:${entry.plugin.id}`, entry, { ...appContext(entry.plugin), settings: entry.plugin.aiws.settings.get() });
      }
    }
    if (focusKey) { const target = (focused.id && document.getElementById(focused.id)) || [...root.querySelectorAll('[data-plugin-setting]')].find(input => `${input.dataset.pluginId}:${input.dataset.pluginSetting}` === focusKey); target?.focus({ preventScroll: true }); }
  }
  async function busy(id, action) {
    panelState.busy.add(id); if (host.settingsHost?.isConnected) renderSettings(host.settingsHost);
    try { await action(); } catch (error) { host.bridge.error(error.message); } finally { panelState.busy.delete(id); await kit.reload(); }
  }
  function readSettings(id) {
    const info = host.catalog.find(item => item.id === id), values = {};
    for (const input of withData(host.settingsHost, 'plugin-id', id).filter(element => element.hasAttribute('data-plugin-setting'))) {
      const field = info?.manifest?.settings.find(item => item.key === input.dataset.pluginSetting); if (!field) continue;
      values[field.key] = field.type === 'boolean' ? input.checked : field.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    }
    return values;
  }
  async function installFolder() {
    const path = host.settingsHost.querySelector('#plugin-install-path').value.trim(), mode = host.settingsHost.querySelector('#plugin-install-link').checked ? 'link' : 'copy';
    if (!path) { panelState.installError = t('Eklenti klasörünün tam yolunu yaz.'); renderSettings(host.settingsHost); return; }
    await install({ path, mode });
  }
  async function install(body) {
    panelState.installBusy = true; panelState.installError = ''; renderSettings(host.settingsHost);
    try { const info = await api('/plugins', 'POST', body); host.bridge.toast(`${t('Eklenti kuruldu')}: ${localized(info.manifest?.name) || info.id}`); const input = host.settingsHost?.querySelector('#plugin-install-path'); if (input) input.value = ''; }
    catch (error) { panelState.installError = error.message; }
    finally { panelState.installBusy = false; await kit.reload(); }
  }
  const toBase64 = buffer => { let binary = ''; const bytes = new Uint8Array(buffer); for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); };
  document.addEventListener('click', async event => {
    const target = event.target.closest?.('#plugins-settings button'); if (!target || !host.settingsHost?.contains(target) || target.disabled) return;
    const data = target.dataset;
    if ('pluginSkillInstall' in data) {
      host.skillBusy = true; renderSettings(host.settingsHost);
      try { host.skillStatus = await api('/plugin-skill', 'POST', { force: data.force === 'true' }); host.bridge.toast(t('Eklenti geliştirme skill’i yüklendi')); }
      catch (error) { host.bridge.error(error.message); await loadSkillStatus(); }
      finally { host.skillBusy = false; if (host.settingsHost?.isConnected) renderSettings(host.settingsHost); }
      return;
    }
    if ('pluginInstallFolder' in data) { await installFolder(); return; }
    if ('pluginRescan' in data) { await kit.reload(); host.bridge.toast(t('Eklentiler yeniden tarandı')); return; }
    if ('pluginChooseFolder' in data) { const result = await global.aiwsDesktop.chooseDirectory({ language: i18n.language }).catch(() => null); if (result?.path) host.settingsHost.querySelector('#plugin-install-path').value = result.path; return; }
    if (data.pluginDetails) { if (panelState.open.has(data.pluginDetails)) panelState.open.delete(data.pluginDetails); else panelState.open.add(data.pluginDetails); renderSettings(host.settingsHost); return; }
    if (data.pluginLogs) { try { panelState.logs.set(data.pluginLogs, (await api(`/plugins/${encodeURIComponent(data.pluginLogs)}/logs`)).logs); } catch (error) { host.bridge.error(error.message); } renderSettings(host.settingsHost); return; }
    if (data.pluginSaveSettings) { const id = data.pluginSaveSettings, values = readSettings(id); await busy(id, async () => { kit.applyInfo(await api(`/plugins/${encodeURIComponent(id)}`, 'PATCH', { settings: values })); host.bridge.toast(t('Eklenti ayarları kaydedildi')); }); return; }
    if (data.pluginReload) { const id = data.pluginReload; host.reloadCount++; kit.deactivate(id); const info = host.catalog.find(item => item.id === id); if (info?.enabled) await kit.activate(info); renderSettings(host.settingsHost); host.bridge.toast(t('Eklenti yeniden yüklendi')); return; }
    if (data.pluginUninstall) {
      const id = data.pluginUninstall, info = host.catalog.find(item => item.id === id);
      const confirmed = await kit.confirmModal({ id: 'host', errors: [] }, { title: t('Eklenti kaldırılsın mı?'), message: `${localized(info?.manifest?.name) || id}: ${info?.mode === 'link' ? t('Bağlantı kaldırılır; klasörün silinmez.') : t('Eklenti klasörü silinir. Görevlerdeki eklenti verileri korunur.')}`, confirmLabel: t('Kaldır') });
      if (!confirmed) return;
      kit.deactivate(id); await busy(id, () => api(`/plugins/${encodeURIComponent(id)}`, 'DELETE'));
    }
  });
  document.addEventListener('change', async event => {
    const target = event.target;
    if (!host.settingsHost?.contains(target)) return;
    if (target.dataset.pluginToggle) { const id = target.dataset.pluginToggle, enabled = target.checked; if (!enabled) kit.deactivate(id); await busy(id, () => api(`/plugins/${encodeURIComponent(id)}`, 'PATCH', { enabled })); return; }
    if (target.matches('[data-plugin-theme-choice]')) { kit.applyTheme(target.value); return; }
    if (target.matches('[data-plugin-install-zip]')) {
      const file = target.files?.[0]; target.value = ''; if (!file) return;
      await install({ archive: toBase64(await file.arrayBuffer()), fileName: file.name });
    }
  });
  // Plugin fields live inside the settings form; Enter must not submit the work settings.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !host.settingsHost?.contains(event.target) || event.target.tagName === 'TEXTAREA') return;
    event.preventDefault();
    if (event.target.id === 'plugin-install-path') void installFolder();
  });
  Object.assign(kit, { renderSettings });
})(window);
