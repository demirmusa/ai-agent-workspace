# AIWS Example Plugin (`aiws.example`)

A reference plugin that shows the plugin API end to end. Each part is explained with numbered comments in
`plugin.js` and `server.js`.

| Feature | Where | Code |
|---|---|---|
| "Task statistics" page and sidebar item (with an open task count badge) | Sidebar → Plugins | `sidebar.addItem`, `pages.register` |
| "Quick note" button and note window | Header (while a project is open) | `topbar.addButton`, `ui.modal`, `storage` |
| "Notes" tab, notes per project | Project tabs | `projectTabs.add`, `storage` |
| Estimate and acceptance criteria fields | New task / edit window, below the description | `taskForm.addSection` (`placement: 'main'`) |
| Risk level tab | New task → Advanced options → Risk | `taskForm.addSection` |
| Planning panel (risk is edited in place) | Task detail → Information → right column | `taskDetail.addSection` (`placement: 'sidebar'`) |
| Checklist tab | Task detail → Checklist | `taskDetail.addTab`, `ctx.saveData` |
| "Copy summary" | Task detail → ⋯ menu | `taskDetail.addAction` |
| Estimate, risk and criteria badges | Task cards | `taskCard.addBadge` |
| `Ctrl+Shift+Y` opens the statistics page | Everywhere | `commands.register` |
| Notification when a task is done | — | `events.on('task:statusChanged')` |
| "Midnight" (light + dark) and "Forest" (dark) themes | Settings → Plugins → Theme | `plugin.json` → `themes` |
| "Highlight" theme built from the color in settings | Settings → Plugins → Theme | `themes.register`, `settings.onChange` |
| Settings and the "Test connection" panel | Settings → Plugins → card → Details | `plugin.json` → `settings`, `settings.addPanel` |
| `/ping`, `/stats`, `/tasks/:taskId/estimate` routes | `/api/plugins/aiws.example/routes/...` | `server.js` → `routes` |
| Adding the estimate and acceptance criteria to the agent prompt | When a task run starts | `server.js` → `prompt.contribute` |
| Writing status changes to the log | `aiws control plugins logs aiws.example` | `server.js` → `events.on` |

Task data is kept under `task.pluginData["aiws.example"]`:

```json
{ "estimate": 3, "risk": "medium", "criteria": [{ "text": "Tests pass", "done": true }] }
```

Updating the estimate from an external tool (add `Authorization: Bearer` if the server has a token):

```powershell
curl -X POST http://127.0.0.1:4317/api/plugins/aiws.example/routes/tasks/<taskId>/estimate -H "Content-Type: application/json" -d '{"estimate":5}'
```

The plugin's own UI strings are written in Turkish, the app's source language, and translated to English through
`i18n.t()`; see the dictionary at the top of `plugin.js`.
