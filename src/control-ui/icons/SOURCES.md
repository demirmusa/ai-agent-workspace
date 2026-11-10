# Provider icons

## AIWS — `aiws.svg`

The application's own mark, created for this repository (MIT): a mint terminal
prompt beside three workspace panels on a midnight blue tile. The simple,
rounded geometry remains legible at favicon and tray sizes. Brand colors are
fixed across light and dark themes.

`aiws.svg` is the single artwork source for the favicon and sidebar badge.
`aiws-32.png` and `aiws-256.png` are transparent desktop derivatives used by
`desktop-app/app-icon.ts` for the tray, window and taskbar. After editing the SVG,
regenerate and commit both PNGs by running from `src`:

```powershell
.\node_modules\electron\dist\electron.exe scripts/render-app-icon.cjs
```

## GitHub Copilot — `copilot.svg`

A simple generic glyph created for this repository (MIT): a dark rounded
visor with two eyes. It is not GitHub's logo and only marks the selected
provider; it contains only static SVG shapes.

Downloaded on 2026-10-16 for product identification in the local AIWS interface.
Files are served locally; the application does not hotlink provider assets.

## Codex — `codex.svg`

- Product: [OpenAI Codex](https://openai.com/codex/).
- Original OpenAI repository URL: [openai/agents.md, public/logos/codex.svg](https://github.com/openai/agents.md/blob/6ae22720966e9cca6b2c2dd0780fb7265a87a46c/public/logos/codex.svg). The repository now redirects to `agentsmd/agents.md`.
- OpenAI-authored logo update: commit `6ae22720966e9cca6b2c2dd0780fb7265a87a46c`, author `dkundel-openai`, 2026-08-25, “Update Codex logo”.
- Exact download: https://raw.githubusercontent.com/openai/agents.md/6ae22720966e9cca6b2c2dd0780fb7265a87a46c/public/logos/codex.svg
- MIME: `image/svg+xml`; 2,302 bytes; 24×24 viewBox.
- SHA-256: `0b490f33f9c5b62c7db578f5101497efb87b774720f91b9e878243e761952c52`.
- Upstream code/artwork license: MIT, Copyright (c) 2025 OpenAI; full notice in [LICENSE.agents-md](LICENSE.agents-md).
- [OpenAI brand guidelines and marks terms](https://openai.com/brand/).

This is the Codex terminal/cloud product mark, rather than the generic OpenAI
Blossom. Original bytes, paths, fill and proportions are preserved. The SVG
contains only static SVG/path elements, with no scripts, handlers, embedded
images, external references or styles. A light chip behind the black mark
maintains contrast in both interface themes without recoloring the artwork.

## Claude — `claude.png`

- Product and source page: [Claude by Anthropic](https://claude.com/).
- Exact download: https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png
- The source page's `rel="icon"` points to this same asset with `?w=32&h=32`.
- MIME: `image/png`; 1,198 bytes; 32×32 pixels.
- SHA-256: `4004381309500f25e49a1ae639912ce307ea81da74cc383954a1ac8b9d343fe6`.
- Copyright/trademark: Anthropic. No additional open-source license is asserted
  for this favicon; its ownership is not changed by this repository's MIT license.

The original orange Claude asterisk favicon is stored without modification.
PNG signature/dimensions and successful image decoding were verified.

Provider names and marks belong to their respective owners. Their use identifies
the actual selected provider and does not imply sponsorship or endorsement.
