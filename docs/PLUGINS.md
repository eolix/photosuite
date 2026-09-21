# PhotoSuite sidebar plugins

A plugin is a small web page that PhotoSuite loads into a panel on the right
sidebar, listed in the **Window** menu alongside Layers and History. It is plain
HTML, CSS and JavaScript — no build step, no fork of the app.

## Quick start

Copy the example into your plugins folder and restart the app:

```bash
# macOS
cp -R examples/plugins/hello-panel "$HOME/Library/Application Support/app.photosuite/plugins/"
```

| OS | Plugins folder |
|----|----|
| macOS | `~/Library/Application Support/app.photosuite/plugins/` |
| Linux | `~/.local/share/app.photosuite/plugins/` |
| Windows | `%APPDATA%\app.photosuite\plugins\` |

PhotoSuite creates the folder on first launch and scans it once at startup, so
restart after every change. Then open **Window → Hello World**.

## Layout

One folder per plugin, manifest at its root. Only the manifest is fixed by name;
everything else is whatever you point it at.

```
my-plugin/
  plugin.json     required
  index.html      entry page
  icon.svg        sidebar icon
  panel.js        your code
```

## `plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "entry": "index.html",
  "icon": "icon.svg",
  "width": 320,
  "height": 420,
  "themed": true,
  "minAppVersion": "0.9.0"
}
```

| Field | | Notes |
|---|---|---|
| `id` | required | Letters, digits, `-`, `_`; max 64. Becomes the panel id `plg_<id>`. |
| `name` | required | Shown in the Window menu and on the tab. |
| `version` | required | Informational. |
| `entry` | required | HTML file inside this folder. |
| `icon` | required | Icon file inside this folder. |
| `width` `height` | required | Panel size in CSS pixels, both non-zero. |
| `themed` | optional | `true` tints a single-colour icon to match the theme. Default `false`. |
| `minAppVersion` | optional | The folder is skipped, with a reason, on a build older than this. |

Fields the manifest carries that the loader does not know are ignored, so a
plugin can keep its own metadata beside these.

`entry` and `icon` must resolve inside the plugin folder — absolute paths and
`..` are rejected. A folder that fails validation — a bad id, a zero dimension,
a file resolving outside the folder, an app too old for `minAppVersion` — is
skipped with a reason on stderr; the rest still load.

## Writing the panel

Write the entry page normally. Before rendering, PhotoSuite reads it and inlines
every same-folder `<script src>` and `<link rel="stylesheet">` into the document:

```html
<link rel="stylesheet" href="styles.css" />
<script src="panel.js"></script>
```

**Only those two tags are inlined.** The page is then rendered from a string, so
it has no base URL and any other relative reference — `<img src="logo.png">`,
`@font-face`, `fetch("data.json")` — will not resolve. Inline images as
`data:` URLs or SVG markup, and embed data in your JavaScript.

## Talking to PhotoSuite

Messaging is [`postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage);
there is no SDK to install.

**Host → plugin.** PhotoSuite posts `"done"` once the editor is ready:

```js
window.addEventListener("message", (event) => {
  if (event.data === "done") console.log("editor ready");
});
```

**Plugin → host.** What you send decides what happens:

| Payload | Effect |
|---|---|
| A plain string that is not JSON | Runs as an action script (the File → Scripts engine) |
| An `ArrayBuffer` | Opened as a file |
| `{ psPlugin: 1, cmd, requestId }` | A request the host answers — see [Requests](#requests) |
| Any other object, or a string starting with `{` | Ignored |

```js
parent.postMessage([
  "if (app.documents.length == 0) {",
  "  app.echoToOE('need-a-document');",
  "} else {",
  "  var layer = app.activeDocument.artLayers.add();",
  "  layer.kind = LayerKind.TEXT;",
  "  layer.textItem.contents = 'Hello World!';",
  "  app.echoToOE('added');",
  "}"
].join("\n"), "*");
```

`app.echoToOE("…")` inside a script sends a string back to your `message`
listener. It shows nothing on screen — display it yourself.

Action scripts drive the editor but cannot hand anything back except the short
string from `echoToOE`. To read data out, use a request.

## Requests

Send `{ psPlugin: 1, cmd, requestId }` and the host replies to your frame alone,
echoing `requestId` so you can match answer to question:

```js
function request(cmd) {
  const requestId = String(Math.random());
  return new Promise((resolve) => {
    window.addEventListener("message", function onReply(event) {
      const reply = event.data;
      if (reply == null || reply.psPlugin !== 1 || reply.requestId !== requestId) return;
      window.removeEventListener("message", onReply);
      resolve(reply);
    });
    parent.postMessage({ psPlugin: 1, cmd, requestId }, "*");
  });
}

const shot = await request("getComposite");
// shot.png is an ArrayBuffer of PNG bytes
```

| `cmd` | Reply `cmd` | Reply fields |
|---|---|---|
| `ping` | `pong` | — |
| `getComposite` | `composite` | `png` (transferred `ArrayBuffer`), `mime`, `width`, `height`, `sourceWidth`, `sourceHeight`, `scale` |

Anything that fails comes back as `cmd: "error"` with an `error` string.

`getComposite` renders the visible document without flattening its layers. The
result is capped at 2048px on its longest edge; `scale` tells you the ratio
applied, and `sourceWidth`/`sourceHeight` give the true document size, so you can
map coordinates back.

Only frames the sidebar created are answered — other embedded content cannot ask
for your document by copying the message shape.

## Sandboxing

Plugins run in an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`, which puts each plugin in its own opaque origin. A plugin
can post messages to the host, but cannot read the host page, its storage, or
the desktop command bridge.

That boundary does not make an untrusted plugin safe. Action scripts run with
the editor's full authority — reading, altering and writing your documents.
Install plugins the way you would run any script on your own machine.

## Troubleshooting

| Symptom | Check |
|---|---|
| Panel missing | Folder sits directly in the plugins directory; `plugin.json` parses; `entry` and `icon` exist. Restart. |
| Blank panel | Console errors in devtools. Scripts and styles must be same-folder relative paths to be inlined. |
| Image or font missing | Expected — see [Writing the panel](#writing-the-panel). Use `data:` URLs. |
| `postMessage` does nothing | Send an action-script string or an `ArrayBuffer`, not a JSON object. |
| Icon wrong in dark mode | `"themed": true` needs a monochrome icon; use `false` for colour artwork. |

## Example

[`examples/plugins/hello-panel/`](../examples/plugins/hello-panel/) — manifest,
themed icon, host messaging, and a button that adds a text layer.
