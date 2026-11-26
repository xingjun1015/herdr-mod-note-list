// Copies the Notes mod into the Herdr app's home (~/.config/herdr-app/mods/notes).
// Usage: node scripts/install-app.mjs [--sync-only]
// The mod's core.js is a copy of src/core.mjs (the app runs mods in QuickJS, so it cannot import from src/).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const modDir = path.join(root, "herdr-app", "mods", "notes");
fs.copyFileSync(path.join(root, "src", "core.mjs"), path.join(modDir, "core.js"));
if (process.argv.includes("--sync-only")) process.exit(0);

const home = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
if (!fs.existsSync(home)) { console.error(`Herdr app home not found: ${home}`); process.exit(1); }
const dest = path.join(home, "mods", "notes");
fs.mkdirSync(dest, { recursive: true });
// core.js and the assets first, main.js last: saving main.js reloads the mod.
const files = fs.readdirSync(modDir).sort((a, b) => (a === "main.js") - (b === "main.js"));
for (const f of files) fs.copyFileSync(path.join(modDir, f), path.join(dest, f));
console.log(`Installed ${files.length} files to ${dest}`);
console.log(`Check it: herdr-app check "${dest}"`);
