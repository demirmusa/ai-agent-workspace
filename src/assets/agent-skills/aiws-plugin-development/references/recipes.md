# Recipes

Each recipe is a complete `activate` body or file. Combine them in one plugin. A full working plugin that uses almost
every extension point ships with AIWS's source as `examples/plugins/aiws-example-plugin` (plus the theme-only
`examples/plugins/aiws-theme-sunset`).

## Minimal skeleton

`plugin.json`
```json
{
  "id": "acme.hello",
  "name": { "tr": "Merhaba", "en": "Hello" },
  "version": "0.1.0",
  "apiVersion": 1,
  "description": { "tr": "İlk eklentim.", "en": "My first plugin." },
  "main": "plugin.js",
  "styles": ["style.css"]
}
```

`plugin.js`
```js
export function activate(aiws) {
  const { ui, i18n } = aiws;
  i18n.add({ en: { 'Merhaba': 'Hello', 'Merhaba dünya!': 'Hello world!' } });
  const t = i18n.t;
  aiws.sidebar.addItem({ id: 'hello', label: t('Merhaba'), icon: 'spark', page: 'hello' });
  aiws.pages.register({
    id: 'hello', title: t('Merhaba'),
    render(container) { container.innerHTML = ui.html`<div class="ah-page"><h2>${t('Merhaba dünya!')}</h2></div>`; },
  });
}
```

`style.css`
```css
.ah-page{padding:20px 24px;color:var(--ink)}
```

Develop: `aiws control plugins install ./acme.hello --link`, edit, press "Yeniden yükle" on the plugin card.
Ship: `aiws control plugins pack ./acme.hello` → `acme.hello-0.1.0.zip`.

## A page that follows live state

```js
aiws.pages.register({
  id: 'running', title: 'Running agents',
  render(container) {
    let last = '';
    const draw = () => {
      const runs = aiws.state().runs.filter(run => run.status === 'running');
      const key = runs.map(run => run.id).join();
      if (key === last) return;              // update() runs on every app render: skip when nothing changed
      last = key;
      const title = run => aiws.tasks.get(run.taskId)?.title || run.taskId;
      container.innerHTML = runs.length
        ? aiws.ui.html`<ul class="ar-list">${aiws.ui.raw(runs.map(run => aiws.ui.html`<li><button type="button" class="button small ghost" data-task="${run.taskId}">${title(run)}</button> · ${run.provider}</li>`).join(''))}</ul>`
        : aiws.ui.html`<p class="form-hint">Nothing is running.</p>`;
    };
    container.addEventListener('click', event => { const id = event.target.closest('[data-task]')?.dataset.task; if (id) aiws.navigate.task(id); });
    draw();
    return { update: draw };
  },
});
aiws.sidebar.addItem({ id: 'running', label: 'Running', icon: 'clock', page: 'running',
  badge: () => aiws.state().runs.filter(run => run.status === 'running').length || '' });
```

## A custom field on tasks (editor + detail + card)

```js
const ID = aiws.plugin.id;
aiws.taskForm.addSection({
  id: 'customer', title: 'Customer', placement: 'main',
  render(container, ctx) {
    container.innerHTML = aiws.ui.html`<div class="form-field"><label for="ac-customer">Customer</label><input id="ac-customer" value="${ctx.data.customer || ''}" maxlength="120"></div>`;
    return {
      validate: () => container.querySelector('#ac-customer').value.length > 120 ? 'Too long' : null,
      collect: () => ({ customer: container.querySelector('#ac-customer').value.trim() || null }),
    };
  },
});
aiws.taskDetail.addSection({
  id: 'customer', title: 'Customer', placement: 'sidebar',
  render(container, ctx) {
    const draw = c => {
      container.innerHTML = aiws.ui.html`<dl class="issue-fields"><div class="issue-field"><dt>Customer</dt><dd><input data-ac value="${c.data.customer || ''}"></dd></div></dl>`;
      container.querySelector('[data-ac]').onchange = event => c.saveData({ ...c.data, customer: event.target.value.trim() || null });
    };
    draw(ctx);
    return { update: c => { if (!container.contains(document.activeElement)) draw(c); } };  // keep typing intact
  },
});
aiws.taskCard.addBadge({ id: 'customer', render: task => task.pluginData?.[ID]?.customer ? { text: task.pluginData[ID].customer, tone: 'accent' } : null });
```

## Server route that calls an external API (browser cannot)

`server.js`
```js
export function activate({ routes, settings }) {
  routes.get('/weather', async ({ query }) => {
    const response = await fetch(`${settings.get('apiUrl')}?city=${encodeURIComponent(query.city || 'Istanbul')}`);
    if (!response.ok) throw new Error(`Weather API ${response.status}`);
    return await response.json();
  });
}
```
`plugin.js`
```js
aiws.topbar.addButton({ id: 'weather', label: 'Weather', icon: 'spark', async onClick() {
  try { const data = await aiws.http.route('weather', { query: { city: 'Ankara' } }); aiws.ui.toast(`${data.temperature} °C`); }
  catch (error) { aiws.ui.error(error.message); }
} });
```

## Project tab with per-project storage

```js
aiws.projectTabs.add({
  id: 'links', label: 'Links',
  render(container, ctx) {
    const key = `links:${ctx.project.id}`;
    const draw = async () => {
      const links = (await aiws.storage.get(key)) || [];
      container.innerHTML = aiws.ui.html`<div class="al-page"><form data-al><input name="url" type="url" required placeholder="https://..."><button class="button small primary">Add</button></form>
        <ul>${aiws.ui.raw(links.map(link => aiws.ui.html`<li><a href="${link}" target="_blank" rel="noreferrer">${link}</a></li>`).join(''))}</ul></div>`;
      container.querySelector('[data-al]').onsubmit = async event => {
        event.preventDefault();
        await aiws.storage.set(key, [...links, new FormData(event.target).get('url')]);
        await draw();
      };
    };
    void draw();
  },
});
```

## Theme only (no code)

```json
{
  "id": "acme.theme-ocean", "name": "Ocean", "version": "1.0.0",
  "themes": [{
    "id": "ocean", "name": "Ocean",
    "dark":  { "ground": "#0c1a24", "sidebar": "#09151d", "surface": "#11222f", "surface-hover": "#16293a", "raised": "#1c3346",
               "ink": "#d7e7f2", "ink-strong": "#f3faff", "muted": "#8fa9bb", "faint": "#5d7687", "line": "#1d3344", "line-strong": "#284357",
               "accent": "#2fb5d9", "accent-hover": "#52c6e5", "accent-ink": "#04141b", "link": "#69cbe6",
               "primary": "#e6f4fb", "primary-hover": "#ffffff", "primary-ink": "#0c1a24" },
    "light": { "ground": "#f4f9fc", "surface": "#ffffff", "raised": "#e5f0f6", "ink": "#12303f", "ink-strong": "#06171f",
               "muted": "#557384", "line": "#dbe8ef", "line-strong": "#c9dbe5", "accent": "#0e86a8", "accent-hover": "#0b7290",
               "accent-ink": "#ffffff", "link": "#0b7a99", "primary": "#12303f", "primary-hover": "#1d4457", "primary-ink": "#ffffff" }
  }]
}
```

## Theme generated from a setting

```js
let off;
const apply = () => { off?.(); const c = aiws.settings.get('accent'); off = aiws.themes.register({ id: 'custom', name: 'Custom accent', dark: { accent: c, link: c }, light: { accent: c, link: c } }); };
apply();
aiws.settings.onChange(apply);
```

## Task action and command

```js
aiws.taskDetail.addAction({ id: 'duplicate', label: 'Duplicate', async run(ctx) {
  const copy = await aiws.tasks.create({ projectId: ctx.task.projectId, title: `${ctx.task.title} (copy)`, description: ctx.task.description, status: 'backlog' });
  aiws.navigate.task(copy.id);
} });
aiws.commands.register({ id: 'new-bug', title: 'New bug', shortcut: 'Ctrl+Shift+B', async run() {
  const project = aiws.project(); if (!project) return aiws.ui.error('Open a project first');
  await aiws.tasks.create({ projectId: project.id, title: 'Bug: ', status: 'backlog', tags: ['bug'] });
} });
```

## React to events

```js
aiws.events.on('run:finished', ({ run }) => { if (run.status === 'failed') aiws.ui.error(`Run failed: ${aiws.tasks.get(run.taskId)?.title}`); });
aiws.events.on('task:statusChanged', ({ task, to }) => { if (to === 'review') aiws.ui.toast(`Ready for review: ${task.title}`); });
```

## Dialog with a form

```js
aiws.ui.modal({
  title: 'Estimate', submitLabel: 'Save',
  body: aiws.ui.html`<div class="form-field"><label for="ae-points">Points</label><input id="ae-points" name="points" type="number" min="0" required></div>`,
  async onSubmit(data) {
    const points = Number(data.get('points'));
    if (points > 100) throw new Error('At most 100 points');   // shown in the dialog, which stays open
    await aiws.tasks.setData(aiws.task().id, { ...aiws.tasks.getData(aiws.task().id), points });
  },
});
```

## Decorate an element without an extension point (last resort)

```js
aiws.dom.onElement('.board-footer', footer => {
  const note = document.createElement('span'); note.className = 'ui-chip'; note.textContent = 'Plugin active';
  footer.querySelector('.footer-start')?.append(note);
});
```

## Agent prompt context (server.js)

```js
export function activate({ prompt, plugin }) {
  prompt.contribute(task => {
    const data = task.pluginData?.[plugin.id];
    return data?.customer ? `This task is for customer "${data.customer}". Mention them in the summary.` : null;
  });
}
```
