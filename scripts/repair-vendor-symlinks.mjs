#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Traverses a directory recursively and checks for dangling symbolic links.
 * When a symlink points to a non-existent target, an empty placeholder file
 * is created at that target path so Tauri's asset packager (tauri::generate_context!)
 * does not fail with an I/O error on broken links.
 */
function repairSymlinks(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Failed to read directory ${dir}:`, err);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(fullPath);
        const resolvedTarget = path.resolve(dir, target);
        if (!fs.existsSync(resolvedTarget)) {
          fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
          fs.writeFileSync(resolvedTarget, '');
          console.log(`Repaired dangling symlink: ${fullPath} -> ${target} (created placeholder)`);
        }
      } catch (err) {
        console.warn(`Warning: Could not process symlink ${fullPath}:`, err.message);
      }
    } else if (entry.isDirectory()) {
      repairSymlinks(fullPath);
    }
  }
}

const targetDir = process.argv[2] || 'src';
repairSymlinks(path.resolve(targetDir));

