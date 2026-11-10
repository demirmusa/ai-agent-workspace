# Example AIWS plugins

The plugins in this folder are independent of the AIWS sources: you can install them by copying the folder, zipping
it or linking it directly. For the whole plugin system see
[wiki: Plugins and Themes](https://github.com/demirmusa/ai-agent-workspace/wiki/Plugins-and-Themes).

| Folder | Contents |
|---|---|
| [aiws-example-plugin](aiws-example-plugin) | Almost every extension point: page, sidebar item, header button, project tab, task form fields, detail panel/tab/action, card badges, command, settings, storage, server routes, agent prompt context and themes. |
| [aiws-theme-sunset](aiws-theme-sunset) | A theme plugin without code: only `plugin.json`. |

The .NET, React Native, Electron and Angular plugins that tailor the chat to a technology ship with AIWS:
`src/assets/plugins`.

## Installation

From the UI: **Settings → Plugins → Install a plugin**, type the full path of the folder and click
**Install from folder**.

With the CLI:

```powershell
aiws control plugins install examples/plugins/aiws-example-plugin
aiws control plugins install examples/plugins/aiws-theme-sunset
```

While developing, link the folder instead of copying it (file changes appear after **Reload**):

```powershell
aiws control plugins install examples/plugins/aiws-example-plugin --link
```

## Packaging and sharing

```powershell
aiws control plugins pack examples/plugins/aiws-example-plugin   # aiws.example-1.0.0.zip
```

Install the ZIP in another AIWS with **Settings → Plugins → Upload ZIP file** or with
`aiws control plugins install aiws.example-1.0.0.zip`. A ZIP created on Windows by right-clicking the folder and
choosing "Compressed (zipped) folder" is accepted too.

## Write your own plugin

The fastest way: install the `aiws-plugin-development` skill from **Settings → Plugins** and tell an agent what you
want ("Build an AIWS plugin that adds a customer name badge to task cards"). To start by hand, copy the
`aiws-example-plugin` folder, change the `id` in `plugin.json` and delete the sections you do not need.
