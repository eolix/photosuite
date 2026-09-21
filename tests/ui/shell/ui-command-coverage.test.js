/**
 * Every `UiCommand` names something the app shell does, and the shell splits
 * that work in two: `AppWindow` owns the overlay and banner chrome, and
 * `app-controller-ui-dispatch.js` owns everything else. A command with no
 * handler in either place is a dispatch that silently does nothing, which is
 * exactly the failure this check exists to catch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UiCommand } from "../../../src/core/event-bus.js";

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../src");

function read(relPath) {
  return fs.readFileSync(path.join(srcRoot, relPath), "utf8");
}

/** The command names the router's handler table is keyed by. */
function routedCommands() {
  const source = read("ui/shell/app-controller-ui-dispatch.js");
  const body = source.slice(source.indexOf("const UI_COMMAND_HANDLERS = {"));
  const table = body.slice(0, body.indexOf("\n};"));
  return [...table.matchAll(/^ {2}(\w+)\(/gm)].map((match) => match[1]);
}

describe("ui shell command coverage", () => {
  it("every UiCommand has a handler", () => {
    const routed = new Set(routedCommands());
    const windowChrome = new Set(
      [...read("ui/shell/app-window.js").matchAll(/UiCommand\.(\w+)/g)].map((m) => m[1]),
    );

    const unhandled = Object.keys(UiCommand).filter(
      (command) => !routed.has(command) && !windowChrome.has(command),
    );
    assert.deepEqual(unhandled, [], "commands nothing responds to");
  });

  it("no handler is keyed by a command that does not exist", () => {
    const unknown = routedCommands().filter((command) => UiCommand[command] === undefined);
    assert.deepEqual(unknown, [], "handlers for commands no one can dispatch");
  });

  it("each command id is its own name, so a dispatch reads as what it asks for", () => {
    for (const [name, value] of Object.entries(UiCommand)) {
      assert.equal(value, name);
    }
  });
});
