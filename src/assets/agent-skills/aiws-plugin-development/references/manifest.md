# plugin.json reference

`plugin.json` sits at the root of the plugin folder (or at the root of the ZIP, or inside one top-level folder of the ZIP).
The server validates it on install, on every listing and before serving files; an invalid manifest shows as an error on
the plugin card and the plugin does not load. Unknown fields are ignored.

## Folder layout

```text
acme.task-timer/
  plugin.json        required
  plugin.js          browser ES module (manifest "main")
  style.css          stylesheets loaded while the plugin is enabled ("styles")
  server.js          optional Node.js ES module ("server")
  package.json       { "type": "module", "private": true } for server.js
  icon.svg           optional icon ("icon")
  themes/dark.css    optional theme stylesheet (themes[].css)
  assets/...         any other files, served at aiws.plugin.assetUrl('assets/...')
  README.md
```

Limits: 1000 files, 10 MiB per file, 50 MiB per plugin. Symbolic links are rejected. `.git` folders are skipped when
copying. Paths in the manifest are relative, use `/`, and may not contain `..`.

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$`, e.g. `acme.task-timer`. Permanent key for task data, storage, settings and URLs. |
| `name` | text | yes | Display name, ≤80 chars. |
| `version` | string | yes | e.g. `1.2.0` (`[0-9A-Za-z.+-]`, ≤40). Changing it after install is how users see updates. |
| `apiVersion` | integer | no | Plugin API the code targets. Default and current value: `1`. A higher value is refused with "Update AIWS". |
| `description` | text | no | ≤1000 chars; shown on the plugin card. |
| `author` | string | no | ≤200 chars. |
| `homepage` | string | no | `http(s)://` URL. |
| `icon` | path | no | `.svg`, `.png`, `.webp`, `.jpg`; shown on the plugin card. |
| `main` | path | no | Browser ES module (`.js`/`.mjs`) exporting `activate(aiws)`. |
| `styles` | path[] | no | Up to 20 `.css` files, linked while the plugin is enabled. |
| `server` | path | no | Node.js ES module (`.js`/`.mjs`) exporting `activate(context)`. Runs inside the control server. |
| `themes` | object[] | no | Up to 20 themes (see below). A plugin may consist of themes only. |
| `settings` | object[] | no | Up to 50 setting fields (see below), rendered on the plugin card. |

**Text** fields accept a plain string or an object of language codes: `{ "tr": "Görev süresi", "en": "Task timer" }`.
The interface language is Turkish (`tr`) or English (`en`); a missing language falls back to `en`, then `tr`, then the
first value.

Every file named by `main`, `server`, `icon`, `styles` or `themes[].css` must exist, otherwise the plugin shows an error.

## Settings

```json
"settings": [
  { "key": "apiUrl", "type": "text", "label": { "tr": "API adresi", "en": "API URL" }, "placeholder": "https://...", "default": "" },
  { "key": "token", "type": "password", "label": "Token" },
  { "key": "notes", "type": "textarea", "label": "Notes" },
  { "key": "limit", "type": "number", "label": "Limit", "min": 1, "max": 50, "default": 10 },
  { "key": "enabledOnCards", "type": "boolean", "label": "Show on cards", "default": true },
  { "key": "mode", "type": "select", "label": "Mode", "default": "fast", "options": [ { "value": "fast", "label": "Fast" }, { "value": "safe", "label": { "tr": "Güvenli", "en": "Safe" } } ] },
  { "key": "color", "type": "color", "label": "Colour", "default": "#7c5cff" }
]
```

| Property | Notes |
|---|---|
| `key` | `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`, unique. |
| `type` | `text` (default), `textarea`, `password`, `number`, `boolean`, `select`, `color`. |
| `label`, `description`, `placeholder` | text. |
| `default` | Must be valid for the type. Without it: `false`, `min` or `0`, first option, or `""`. |
| `options` | Required for `select`: `[{ "value": string, "label": text }]`, ≤100. |
| `min`, `max` | Numbers, validated for `number`. |

`color` values are hex (`#rgb`, `#rrggbb`, `#rrggbbaa`). Values are validated by the server on save, stored in the AIWS
data folder (`plugins.json`) and returned to both the browser (`aiws.settings.get`) and the server (`context.settings.get`).
`password` is only a masked input; it is stored like other settings, so prefer environment variables or OS stores for
real secrets.

## Themes

```json
"themes": [
  {
    "id": "midnight",
    "name": { "tr": "Gece Yarısı", "en": "Midnight" },
    "description": "Navy surfaces, violet accent",
    "dark":  { "ground": "#0f1222", "surface": "#151935", "accent": "#8b7bff", "...": "..." },
    "light": { "ground": "#f6f7fc", "surface": "#ffffff", "accent": "#5b47e0", "...": "..." },
    "css": "themes/midnight.css"
  }
]
```

- `id`: `^[a-z0-9][a-z0-9-]{0,40}$`, unique in the plugin. The theme key is `<plugin id>/<theme id>`.
- `dark` / `light`: token name (with or without `--`) → CSS value. Values may not contain `; { } < >`. Up to 400 tokens.
  A theme needs `dark`, `light` or `css`.
- A mode that the theme does not define uses AIWS's built-in tokens for that mode (a dark-only theme looks like the
  default theme in light mode).
- `css`: optional stylesheet linked only while this theme is selected, for things tokens cannot express (fonts,
  background images). Scope rules to the theme: `:root[data-plugin-theme="acme.pack/midnight"] .task-card { ... }`.
- Users pick a theme in Settings → Eklentiler → Tema. The sidebar light/dark button still switches the mode.
- Token list with defaults: [theme tokens](theme-tokens.md).

How it is applied: the selected theme is written as
`:root[data-plugin-theme="<key>"]:not([data-theme=light]){--token:value}` and
`:root[data-plugin-theme="<key>"][data-theme=light]{--token:value}`, which outrank the built-in token rules.

## Complete example

```json
{
  "id": "acme.task-timer",
  "name": { "tr": "Görev Zamanlayıcı", "en": "Task Timer" },
  "version": "1.0.0",
  "apiVersion": 1,
  "description": { "tr": "Görevlerde geçen süreyi tutar.", "en": "Tracks time spent on tasks." },
  "author": "Acme",
  "icon": "icon.svg",
  "main": "plugin.js",
  "styles": ["style.css"],
  "server": "server.js",
  "settings": [
    { "key": "roundTo", "type": "number", "label": { "tr": "Yuvarlama (dk)", "en": "Round to (min)" }, "min": 1, "max": 60, "default": 5 }
  ],
  "themes": []
}
```
