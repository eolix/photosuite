/**
 * Hello World — adds a text layer via PhotoSuite action script.
 */
(function initHelloWorldPanel() {
  const logEl = document.getElementById("log");
  const addTextButton = document.getElementById("add-text");

  /**
   * Action script run inside PhotoSuite (not in this iframe).
   * Uses app.echoToOE only for status tokens the panel log understands.
   */
  const ADD_HELLO_WORLD_SCRIPT = [
    "if (app.documents.length == 0) {",
    "  app.echoToOE('open-a-document-first');",
    "} else {",
    "  var layer = app.activeDocument.artLayers.add();",
    "  layer.kind = LayerKind.TEXT;",
    "  layer.textItem.contents = 'Hello World!';",
    "  layer.textItem.size = new UnitValue(48, 'px');",
    "  app.echoToOE('hello-world-added');",
    "}"
  ].join("\n");

  const STATUS_MESSAGES = {
    done: "PhotoSuite is ready.",
    "open-a-document-first": "Open or create a document first, then try again.",
    "hello-world-added": "Text layer added — check the canvas and Layers panel."
  };

  function appendLog(line) {
    if (logEl == null) return;
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent = "[" + stamp + "] " + line + "\n" + logEl.textContent;
  }

  function describeHostMessage(payload) {
    if (payload == null) return null;
    if (typeof payload === "string" && STATUS_MESSAGES[payload]) {
      return STATUS_MESSAGES[payload];
    }
    if (typeof payload === "string") return payload;
    return JSON.stringify(payload);
  }

  window.addEventListener("message", function onHostMessage(event) {
    const line = describeHostMessage(event.data);
    if (line == null) return;
    appendLog(line);
  });

  if (addTextButton != null) {
    addTextButton.addEventListener("click", function onAddTextClick() {
      appendLog("Running action script…");
      parent.postMessage(ADD_HELLO_WORLD_SCRIPT, "*");
    });
  }

  appendLog("Panel loaded. Open an image, then use the button.");
})();
