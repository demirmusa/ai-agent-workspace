# Theme tokens

AIWS draws every colour, font, radius, shadow and motion value from CSS custom properties defined once in
`control-ui/styles.css`. A theme (manifest `themes[]` or `aiws.themes.register`) re-values any of them for the dark mode,
the light mode or both; names are written without `--` in theme objects (`"surface": "#151935"`).

Groups:

- **Neutrals** step `ground` → `surface` → `raised`; `sidebar`, `column`, `track` and `surface-sunken` sit below ground;
  `popover` and `input` are menus and form fields. `surface-hover` is the hover state of surfaces.
- **Text**: `ink` (body), `ink-strong` (titles), `muted` (secondary), `faint` (placeholders, hints).
- **Lines**: `line` (hairlines), `line-strong` (control borders); `canvas-dot` is the dotted canvas.
- **Accent** marks selection, focus, links and toggles: `accent`, `accent-hover`, `accent-ink` (text on accent), `link`, `focus`.
- **Primary** buttons are ink-inverted: `primary`, `primary-hover`, `primary-ink`.
- **Tones** colour status: `tone-<running|done|needs|failed|idle>` (text/icon), `-bg` (tinted fill), `-line` (border).
  `success`, `warning`, `danger` alias tones.
- **Overlays**: `selection`, `overlay` (dialog backdrop), `scrim`, `shimmer` (skeleton highlight).
- **Data viz** `viz-1..5`, `viz-empty`; **tooltips** `tooltip-bg/ink/muted`; **elevation** `shadow-1`, `shadow-2`,
  `shadow-pop`, `shadow-float`.
- **Terminals** follow the mode, including the xterm colors: `terminal*` tokens.
- **Shape and motion** (rarely themed): `radius-*`, `dur-*`, `ease-*`, `font-ui`, `font-mono`, `control-h`.

Tips:

- Define a full neutral, text, line, accent and primary set for each mode you support; keep `ink` on `surface` at
  ≥4.5:1 contrast and `accent-ink` readable on `accent`.
- Keep tones recognisable (green done, amber needs, red failed, blue running); adjust lightness for your surfaces.
- `focus` defaults to `var(--accent)`; override it only for contrast.
- A theme `css` file can change fonts: `:root[data-plugin-theme="acme.pack/mono"]{--font-ui:"JetBrains Mono",monospace}`
  (fonts must be bundled in the plugin and loaded with `@font-face` from a relative URL — external URLs are blocked).

## All tokens with built-in values

`—` in the light column means the token has the same value in both modes.

| Token | Dark (default) | Light |
|---|---|---|
| `--font-ui` | `"Inter var","Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif` | — |
| `--font-mono` | `"Cascadia Code","Cascadia Mono",Consolas,"SFMono-Regular",monospace` | — |
| `--control-h` | `30px` | — |
| `--files-panel-width` | `280px` | — |
| `--floating-console-header-height` | `30px` | — |
| `--floating-console-dock-width` | `260px` | — |
| `--floating-console-inset` | `8px` | — |
| `--floating-console-gap` | `8px` | — |
| `--radius-sm` | `6px` | — |
| `--radius` | `8px` | — |
| `--radius-md` | `10px` | — |
| `--radius-lg` | `12px` | — |
| `--radius-xl` | `16px` | — |
| `--radius-pill` | `999px` | — |
| `--dur-fast` | `120ms` | — |
| `--dur` | `180ms` | — |
| `--dur-slow` | `280ms` | — |
| `--dur-enter` | `340ms` | — |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | — |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | — |
| `--ease-spring` | `cubic-bezier(.34,1.4,.64,1)` | — |
| `--focus` | `var(--accent)` | — |
| `--ring` | `0 0 0 3px color-mix(in srgb,var(--accent) 28%,transparent)` | — |
| `--success` | `var(--tone-done)` | — |
| `--warning` | `var(--tone-needs)` | — |
| `--danger` | `var(--tone-failed)` | — |
| `--tone` | `var(--tone-idle)` | — |
| `--tone-bg` | `var(--tone-idle-bg)` | — |
| `--tone-line` | `var(--tone-idle-line)` | — |
| `--ground` | `#1b1a1d` | `#f9f9fa` |
| `--sidebar` | `#161518` | `#f6f6f8` |
| `--surface` | `#1f1e22` | `#ffffff` |
| `--surface-hover` | `#26252a` | `#f0f0f3` |
| `--raised` | `#2c2b30` | `#ececef` |
| `--surface-sunken` | `#131215` | `#ededee` |
| `--column` | `#151417` | `#f2f2f4` |
| `--track` | `#141316` | `#efeff1` |
| `--popover` | `#232226` | `#ffffff` |
| `--input` | `#18171a` | `#ffffff` |
| `--ink` | `#dcdce0` | `#1f1f23` |
| `--ink-strong` | `#f5f5f7` | `#0b0b0d` |
| `--muted` | `#94939b` | `#67676f` |
| `--faint` | `#65646c` | `#9d9da5` |
| `--line` | `#2b2a2f` | `#e7e7ea` |
| `--line-strong` | `#38373d` | `#dddde2` |
| `--canvas-dot` | `#2e2d33` | `#dcdce0` |
| `--selection` | `#ffffff1a` | `#18181b12` |
| `--overlay` | `#0a090c99` | `#18181b52` |
| `--scrim` | `#0a090c59` | `#18181b24` |
| `--shimmer` | `#ffffff12` | `#ffffffcc` |
| `--accent` | `#5b80f5` | `#2f62e9` |
| `--accent-hover` | `#7393f7` | `#2554d6` |
| `--accent-ink` | `#ffffff` | `#ffffff` |
| `--link` | `#86a2fa` | `#2a5bdf` |
| `--blue` | `#78a9ff` | `#1b67c9` |
| `--purple` | `#b291f4` | `#7448c8` |
| `--primary` | `#f2f2f4` | `#18181b` |
| `--primary-hover` | `#ffffff` | `#2c2c31` |
| `--primary-ink` | `#121214` | `#ffffff` |
| `--tone-running` | `#8eaaff` | `#2457c5` |
| `--tone-running-bg` | `#1e2a4b` | `#e7eefd` |
| `--tone-running-line` | `#2d3f70` | `#c9d8fb` |
| `--tone-done` | `#5ccf93` | `#18794e` |
| `--tone-done-bg` | `#163020` | `#e3f5e9` |
| `--tone-done-line` | `#21482f` | `#bfe5cd` |
| `--tone-needs` | `#f4a64a` | `#b54708` |
| `--tone-needs-bg` | `#35260f` | `#fdeedc` |
| `--tone-needs-line` | `#553b17` | `#f5d3ad` |
| `--tone-failed` | `#ff7a7e` | `#c4252e` |
| `--tone-failed-bg` | `#3a1b1e` | `#fde8e8` |
| `--tone-failed-line` | `#5c2a2e` | `#f5c4c7` |
| `--tone-idle` | `#a3a2aa` | `#67676f` |
| `--tone-idle-bg` | `#2a292e` | `#efeff1` |
| `--tone-idle-line` | `#38373d` | `#e0e0e4` |
| `--viz-1` | `#e2e2e7` | `#212025` |
| `--viz-2` | `#86858d` | `#848388` |
| `--viz-3` | `#4b4d57` | `#bebdc0` |
| `--viz-4` | `#5678f4` | `#2950ce` |
| `--viz-5` | `#8aa1f3` | `#a0b4fb` |
| `--viz-empty` | `#252429` | `#ebeaed` |
| `--tooltip-bg` | `#2a292e` | `#242328` |
| `--tooltip-ink` | `#f2f2f4` | `#f5f5f7` |
| `--tooltip-muted` | `#a3a2aa` | `#a1a0a8` |
| `--shadow-1` | `0 1px 2px #00000052` | `0 1px 2px #14141f0f` |
| `--shadow-2` | `0 1px 2px #00000040,0 8px 22px -4px #0000008c` | `0 1px 2px #14141f0d,0 8px 22px -6px #14141f24` |
| `--shadow-pop` | `0 2px 8px #0000004d,0 18px 44px -8px #000000b3` | `0 2px 6px #14141f0f,0 16px 40px -8px #14141f2e` |
| `--shadow-float` | `0 8px 28px #00000073,0 30px 80px -12px #000000b3` | `0 6px 20px #14141f14,0 28px 72px -16px #14141f40` |
| `--terminal` | `#161518` | `#fbfbfc` |
| `--terminal-ink` | `#d6d6db` | `#1f1f23` |
| `--terminal-cursor` | `#ecebf0` | `#0b0b0d` |
| `--terminal-selection` | `#2a3a66` | `#c9d8fb` |
| `--terminal-tab` | `#1a191d` | `#efeff1` |
| `--terminal-tab-active` | `#161518` | `#fbfbfc` |
| `--terminal-text` | `#c4c3ca` | `#3c3c43` |
| `--terminal-muted` | `#9b9aa2` | `#67676f` |
| `--terminal-line` | `#ffffff14` | `#18181b14` |
| `--terminal-hover` | `#ffffff12` | `#18181b0d` |
| `--terminal-head` | `#19181c` | `#f2f2f4` |
| `--terminal-head-active` | `#222126` | `#e7e7ea` |
| `--terminal-bar` | `#1d1c20` | `#f2f2f4` |
| `--terminal-chip` | `#2d3134` | `#e4e4e8` |
| `--terminal-accent` | `#9fe3a9` | `#18794e` |
| `--terminal-min-contrast` | `1` | `4.5` |
| `--terminal-ansi-black` | `#2e3436` | `#24292f` |
| `--terminal-ansi-red` | `#cc0000` | `#c4252e` |
| `--terminal-ansi-green` | `#4e9a06` | `#18794e` |
| `--terminal-ansi-yellow` | `#c4a000` | `#8a6100` |
| `--terminal-ansi-blue` | `#3465a4` | `#2457c5` |
| `--terminal-ansi-magenta` | `#75507b` | `#8a3fb0` |
| `--terminal-ansi-cyan` | `#06989a` | `#0f7c86` |
| `--terminal-ansi-white` | `#d3d7cf` | `#6e7781` |
| `--terminal-ansi-bright-black` | `#555753` | `#57606a` |
| `--terminal-ansi-bright-red` | `#ef2929` | `#a61b24` |
| `--terminal-ansi-bright-green` | `#8ae234` | `#136a43` |
| `--terminal-ansi-bright-yellow` | `#fce94f` | `#734f00` |
| `--terminal-ansi-bright-blue` | `#729fcf` | `#1d48a8` |
| `--terminal-ansi-bright-magenta` | `#ad7fa8` | `#7432a0` |
| `--terminal-ansi-bright-cyan` | `#34e2e2` | `#0b6a73` |
| `--terminal-ansi-bright-white` | `#eeeeec` | `#8c959f` |
