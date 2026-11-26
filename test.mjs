// Run: node test.mjs  (no dependencies)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HERDR_NOTES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "notes-test-"));
const s = await import("./src/store.mjs");
const v = await import("./src/view.mjs");

const mk = (o) => s.norm(o);
const a = mk({ id: "a", title: "A", body: "x", upd: 10 }), b = mk({ id: "b", title: "B", pinned: true }), c = mk({ id: "c", title: "C" });

// pinned first, filters
assert.deepEqual(s.visible([a, b, c]).map((n) => n.id), ["b", "a", "c"]);
assert.deepEqual(s.visible([a, b, c], { q: "c" }).map((n) => n.id), ["c"]);
assert.deepEqual(s.visible([a, b, c], { filter: "pinned" }).map((n) => n.id), ["b"]);

// reorder stays inside the pin group
const list = [a, b, c];
assert.equal(s.place(list, "c", "a", false), true);
assert.deepEqual(list.map((n) => n.id), ["c", "a", "b"]);
assert.equal(s.place(list, "c", "b", true), false);

// merge: newest edit wins, deletions win, new notes arrive
const m = s.merge({ notes: [a, c], deleted: [] }, { notes: [{ ...a, title: "A2", upd: 99 }, b, c], deleted: ["c"] });
assert.deepEqual(m.notes.map((n) => n.id + ":" + n.title), ["a:A2", "b:B"]);

// save and load round trip
s.save({ notes: [a, b], deleted: ["z"] });
const l = s.load();
assert.equal(l.notes.length, 2);
assert.deepEqual(l.deleted, ["z"]);

// export and import round trip (JSON and Markdown)
const full = mk({ title: "T", body: "# H\n\n- [ ] one", color: "red", tags: ["x", "y"], status: "todo", pinned: true, due: "2026-12-01" });
const [j] = s.parseImport(s.toJSON([full]), "x.json");
assert.deepEqual({ ...j, id: 0, upd: 0 }, { ...full, id: 0, upd: 0 });
const [md] = s.parseImport(s.toMarkdownFiles([full])[0].content, "x.md");
assert.deepEqual({ ...md, id: 0, upd: 0 }, { ...full, id: 0, upd: 0 });
assert.throws(() => s.parseImport("{nope", "x.json"), /valid JSON/);
assert.equal(s.isDup([full], md), true);

// rendering fits the terminal and never throws
const st = { notes: [a, b, c, full], q: "", filter: "all", tag: "", sel: 0, scroll: 0, prompt: null, msg: "", openId: full.id, cur: 0, rtop: 0,
  edit: { lines: ["T", "# H", "- [ ] one"], r: 1, c: 2, top: 0 } };
for (const [w, h] of [[80, 24], [40, 10], [120, 40]]) {
  for (const f of [v.listScreen, v.readScreen, v.editScreen, v.helpScreen]) {
    const out = f(st, w, h);
    assert.equal(out.lines.length, h, f.name + " height");
    for (const line of out.lines) assert.ok(v.sw(line) <= w, `${f.name} ${w}x${h} too wide: ${v.sw(line)}`);
  }
}
assert.deepEqual(v.wrapAnsi("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
assert.equal(v.sw("你好"), 4);

assert.equal(fs.readFileSync(new URL("./herdr-app/mods/notes/core.js", import.meta.url), "utf8"), fs.readFileSync(new URL("./src/core.mjs", import.meta.url), "utf8"), "core.js is stale: run node scripts/install-app.mjs --sync-only");

fs.rmSync(process.env.HERDR_NOTES_DIR, { recursive: true, force: true });
console.log("ok");
