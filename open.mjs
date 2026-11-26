// Action entrypoint: asks Herdr to open the notes pane. Herdr passes HERDR_BIN_PATH and HERDR_PLUGIN_ID.
import { spawnSync } from "node:child_process";

const bin = process.env.HERDR_BIN_PATH || "herdr";
const id = process.env.HERDR_PLUGIN_ID || "mod.notes";
const r = spawnSync(bin, ["plugin", "pane", "open", "--plugin", id, "--entrypoint", "notes", "--focus"], { stdio: "inherit" });
process.exit(r.status ?? 1);
