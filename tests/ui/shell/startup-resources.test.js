/**
 * Seeding the default preset libraries at launch, and the folder of preset
 * libraries the user chose to keep.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync } from "node:fs";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let STARTUP_PRESET_FILES;
let resourceFileName;
let fetchStartupResource;
let listSavedResources;
let loadSavedResources;
let saveResource;
let deleteSavedResource;
let syncSavedResources;
let realFetch;

before(async () => {
  realFetch = globalThis.fetch;
  ({
    STARTUP_PRESET_FILES, resourceFileName, fetchStartupResource,
    listSavedResources, loadSavedResources, saveResource, deleteSavedResource,
    syncSavedResources,
  } = await import("../../../src/ui/shell/startup-resources.js"));
});

after(() => {
  globalThis.fetch = realFetch;
});

describe("ui/shell/startup-resources.js", () => {
  it("every seed library it names is actually in the bundle", () => {
    // These paths are strings resolved at runtime, so nothing else catches a file
    // a renamed or dropped file — the app would just start with no brushes.
    for (const resourcePath of STARTUP_PRESET_FILES) {
      assert.ok(existsSync("src/" + resourcePath), resourcePath + " is missing from the bundle");
    }
  });

  it("names each library so its format can be detected", () => {
    // The format comes from the extension, exactly as for a file opened from disk.
    assert.equal(resourceFileName("resources/startup/brushes.abr"), "brushes.abr");
    assert.equal(resourceFileName("contours.shc"), "contours.shc");
    assert.deepEqual(
      STARTUP_PRESET_FILES.map((path) => resourceFileName(path).split(".").pop()).sort(),
      ["abr", "grd", "pat", "shc"]
    );
  });

  it("treats an unreadable library as missing rather than fatal", async () => {
    // Losing the default patterns costs the user those presets; it must never stop
    // the app from starting.
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await fetchStartupResource("resources/startup/patterns.pat"), null);

    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await fetchStartupResource("resources/startup/patterns.pat"), null);

    const bytes = new ArrayBuffer(4);
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes });
    assert.equal(await fetchStartupResource("resources/startup/patterns.pat"), bytes);
  });
});

/**
 * Stand in for the desktop host: a resources folder held in memory, driven
 * through the same command names the Rust side exposes.
 */
function fakeResourcesFolder(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const calls = [];
  const failWrites = new Set();

  const previousTauri = globalThis.window.__TAURI__;
  globalThis.window.__TAURI__ = {
    core: {
      invoke(command, args) {
        calls.push(command);
        if (command === "list_user_resources") {
          return Promise.resolve(
            [...files.entries()]
              .map(([name, bytes]) => ({ name, path: "/resources/" + name, size: bytes.byteLength }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
        if (command === "read_file_raw") {
          const name = args.path.replace("/resources/", "");
          if (!files.has(name)) return Promise.reject(new Error("no such file"));
          return Promise.resolve(new Uint8Array(files.get(name)));
        }
        if (command === "user_resource_path") {
          if (failWrites.has(args.name)) return Promise.reject(new Error("read-only volume"));
          return Promise.resolve("/resources/" + args.name);
        }
        if (command === "delete_user_resource") {
          files.delete(args.name);
          return Promise.resolve();
        }
        if (command === "save_file") {
          return Promise.resolve();
        }
        return Promise.reject(new Error("unknown command " + command));
      },
    },
  };

  return {
    files,
    calls,
    failWrites,
    // save_file carries its path percent-encoded in a header, because a header
    // cannot hold a non-ASCII path. Decode it the way the Rust side does.
    captureWrites() {
      globalThis.window.__TAURI__.core.invoke = ((realInvoke) =>
        function (command, args, options) {
          if (command === "save_file") {
            const path = decodeURIComponent(options.headers["X-PhotoSuite-Path"]);
            files.set(path.replace("/resources/", ""), args.buffer ? args.buffer : args);
            calls.push(command);
            return Promise.resolve();
          }
          return realInvoke(command, args);
        })(globalThis.window.__TAURI__.core.invoke);
    },
    restore() { globalThis.window.__TAURI__ = previousTauri; },
  };
}

const bytesOfLength = (n) => new Uint8Array(n).buffer;

describe("ui/shell/startup-resources.js saved libraries", () => {
  it("lists what is in the resources folder", async () => {
    const folder = fakeResourcesFolder({ "brushes.abr": bytesOfLength(8) });
    try {
      const entries = await listSavedResources();
      assert.deepEqual(entries, [{ name: "brushes.abr", path: "/resources/brushes.abr", size: 8 }]);
    } finally {
      folder.restore();
    }
  });

  it("reads every saved library back as bytes", async () => {
    const folder = fakeResourcesFolder({
      "brushes.abr": bytesOfLength(4),
      "gradients.grd": bytesOfLength(6),
    });
    try {
      const storedFiles = await loadSavedResources();
      assert.deepEqual(Object.keys(storedFiles).sort(), ["brushes.abr", "gradients.grd"]);
      assert.ok(storedFiles["brushes.abr"] instanceof ArrayBuffer);
      assert.equal(storedFiles["gradients.grd"].byteLength, 6);
    } finally {
      folder.restore();
    }
  });

  it("keeps the readable libraries when one file will not read", async () => {
    // A single corrupt or locked file must not cost the user the whole set.
    const folder = fakeResourcesFolder({ "good.abr": bytesOfLength(4) });
    folder.files.set("ghost.grd", bytesOfLength(2));
    const realInvoke = globalThis.window.__TAURI__.core.invoke;
    globalThis.window.__TAURI__.core.invoke = (command, args) =>
      command === "read_file_raw" && args.path.endsWith("ghost.grd")
        ? Promise.reject(new Error("unreadable"))
        : realInvoke(command, args);
    try {
      const storedFiles = await loadSavedResources();
      assert.deepEqual(Object.keys(storedFiles), ["good.abr"]);
    } finally {
      folder.restore();
    }
  });

  it("removes a library the user deleted from the manager", async () => {
    const folder = fakeResourcesFolder({
      "keep.abr": bytesOfLength(4),
      "drop.grd": bytesOfLength(4),
    });
    folder.captureWrites();
    try {
      // The Resource Manager edits the in-memory map; syncing applies it.
      await syncSavedResources({ "keep.abr": bytesOfLength(4) });
      assert.deepEqual([...folder.files.keys()], ["keep.abr"]);
    } finally {
      folder.restore();
    }
  });

  it("writes a newly kept library and leaves unchanged ones alone", async () => {
    const folder = fakeResourcesFolder({ "existing.abr": bytesOfLength(4) });
    folder.captureWrites();
    try {
      await syncSavedResources({
        "existing.abr": bytesOfLength(4),   // same size: already on disk
        "added.grd": bytesOfLength(9),
      });
      assert.deepEqual([...folder.files.keys()].sort(), ["added.grd", "existing.abr"]);
      // Only the new library is written; megabyte sets are not rewritten.
      assert.equal(folder.calls.filter((c) => c === "save_file").length, 1);
    } finally {
      folder.restore();
    }
  });

  it("rewrites a library saved again under the same name at a new size", async () => {
    const folder = fakeResourcesFolder({ "brushes.abr": bytesOfLength(4) });
    folder.captureWrites();
    try {
      await syncSavedResources({ "brushes.abr": bytesOfLength(64) });
      assert.equal(folder.files.get("brushes.abr").byteLength, 64);
    } finally {
      folder.restore();
    }
  });

  it("saves a library whose name is not ASCII", async () => {
    // The path rides in a header, which cannot carry these characters raw; a
    // German or Japanese library name has to survive the round trip.
    const folder = fakeResourcesFolder();
    folder.captureWrites();
    try {
      await syncSavedResources({ "Pinsel-Zürich.abr": bytesOfLength(4), "ブラシ.grd": bytesOfLength(4) });
      assert.deepEqual([...folder.files.keys()].sort(), ["Pinsel-Zürich.abr", "ブラシ.grd"]);
    } finally {
      folder.restore();
    }
  });

  it("reports the library it could not save instead of failing silently", async () => {
    const folder = fakeResourcesFolder();
    folder.failWrites.add("brushes.abr");
    const failed = [];
    try {
      await syncSavedResources({ "brushes.abr": bytesOfLength(4) }, (name) => failed.push(name));
      assert.deepEqual(failed, ["brushes.abr"]);
    } finally {
      folder.restore();
    }
  });

  it("does nothing outside the desktop app", async () => {
    const previousTauri = globalThis.window.__TAURI__;
    globalThis.window.__TAURI__ = undefined;
    try {
      assert.deepEqual(await listSavedResources(), []);
      assert.deepEqual(await loadSavedResources(), {});
      assert.equal(await saveResource("brushes.abr", bytesOfLength(4)), false);
      assert.equal(await deleteSavedResource("brushes.abr"), false);
    } finally {
      globalThis.window.__TAURI__ = previousTauri;
    }
  });
});
