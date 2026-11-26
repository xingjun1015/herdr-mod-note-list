// Terminal plugin data layer: notes.json on the machine that runs Herdr.
// The Herdr app mod reads and writes the same file, so both stay in sync.
// Panes run on that host, so remote (SSH) clients use the same notes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { norm, parseFile, fileText } from "./core.mjs";

export * from "./core.mjs";

export const dataDir = () => process.env.HERDR_NOTES_DIR || path.join(os.homedir(), ".herdr-notes");
const file = () => path.join(dataDir(), "notes.json");

export function load() {
  try {
    const raw = fs.readFileSync(file(), "utf8");
    return { ...parseFile(raw), mtime: fs.statSync(file()).mtimeMs, exists: true };
  } catch {
    return { notes: [], deleted: [], mtime: 0, exists: false };
  }
}

export function save(state) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, fileText(state));
  fs.renameSync(tmp, file());
  return fs.statSync(file()).mtimeMs;
}

export { norm };
