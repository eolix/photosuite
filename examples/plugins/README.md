# Example plugins

## `hello-panel`

A sidebar panel that logs messages from PhotoSuite and adds a text layer through
an action script. It covers the whole plugin surface: manifest fields, a themed
icon, `postMessage` in both directions, and `app.echoToOE` for status back from
a running script.

Install it by copying the folder into your plugins directory and restarting:

| OS | Plugins folder |
|----|----|
| macOS | `~/Library/Application Support/app.photosuite/plugins/` |
| Linux | `~/.local/share/app.photosuite/plugins/` |
| Windows | `%APPDATA%\app.photosuite\plugins\` |

Then open **Window → Hello World**. Open a document first — the button needs one.

See [`docs/PLUGINS.md`](../../docs/PLUGINS.md) to write your own.
