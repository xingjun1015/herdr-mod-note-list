// Terminal app: runs as a Herdr pane. State, input handling and file IO live here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "./store.mjs";
import { listScreen, readScreen, editScreen, helpScreen } from "./view.mjs";

const { COLORS, STATUSES, visible, norm, newId } = store;

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error("Notes is a terminal app. Open it from Herdr: herdr plugin action invoke mod.notes.open");
  process.exit(1);
}

const disk = store.load();
const st = {
  notes: disk.notes, deleted: disk.deleted, mtime: disk.mtime,
  view: "list", sel: 0, scroll: 0, q: "", filter: "all", tag: "", openId: null, cur: 0, rtop: 0,
  edit: null, prompt: null, msg: "", undo: null, rowMap: {}, help: false,
};
if (!disk.exists) { st.notes = store.welcome(); persist(); }

const tilde = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const note = () => st.notes.find((n) => n.id === st.openId);
const list = () => visible(st.notes, st);
const current = () => list()[st.sel];
const say = (m) => { st.msg = m; clearTimeout(say.t); say.t = setTimeout(() => { st.msg = ""; draw(); }, 4000); };

function persist() {
  const d = store.load();
  let m = { notes: st.notes, deleted: st.deleted };
  if (d.exists && d.mtime !== st.mtime) m = store.merge(m, d);
  st.notes = m.notes; st.deleted = m.deleted;
  st.mtime = store.save(m);
}
let saveT;
const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(persist, 400); };
const touch = (n) => { n.upd = Date.now(); };
const cycle = (arr, v, d = 1) => arr[(arr.indexOf(v) + d + arr.length) % arr.length];

// ---- drawing ----
const out = (s) => process.stdout.write(s);
function draw() {
  const w = process.stdout.columns || 80, h = process.stdout.rows || 24;
  const scr = st.help ? helpScreen(st, w, h) : st.view === "read" ? readScreen(st, w, h) : st.view === "edit" ? editScreen(st, w, h) : listScreen(st, w, h);
  let buf = "\x1b[?25l";
  for (let i = 0; i < h; i++) buf += `\x1b[${i + 1};1H${scr.lines[i] ?? ""}\x1b[0m\x1b[K`;
  if (scr.cursor) buf += `\x1b[${scr.cursor.row};${scr.cursor.col}H\x1b[?25h`;
  out(buf);
}

// ---- list actions ----
function newNote() {
  const n = norm({ title: "", body: "", color: "gray" });
  st.notes.unshift(n);
  openEdit(n, true);
}
function setStatus(n) { n.status = cycle(STATUSES, n.status); touch(n); persist(); }
function removeNote(n) {
  const i = st.notes.indexOf(n);
  st.notes.splice(i, 1); st.deleted.push(n.id); persist();
  st.undo = () => { st.notes.splice(i, 0, n); st.deleted = st.deleted.filter((x) => x !== n.id); touch(n); persist(); };
  say(`Deleted "${n.title || "Untitled"}". Press u to undo.`);
  st.view = "list";
}
const confirmDelete = (n) => (st.prompt = { label: `Delete "${n.title || "Untitled"}"?  y = delete, any other key = keep`, keys: { y: () => removeNote(n) } });
function tagPrompt(n) {
  st.prompt = { label: "Tag (type again to remove):", value: "", onSubmit: (v) => {
    const t = v.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
    if (!t) return;
    n.tags = n.tags.includes(t) ? n.tags.filter((x) => x !== t) : [...n.tags, t];
    touch(n); persist();
  } };
}
function duePrompt(n) {
  st.prompt = { label: "Due date (YYYY-MM-DD, empty clears):", value: n.due, onSubmit: (v) => {
    v = v.trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return say("Use the format YYYY-MM-DD.");
    n.due = v; touch(n); persist();
  } };
}
function reorder(id, dir) {
  const l = list(), i = l.findIndex((n) => n.id === id), t = l[i + dir];
  if (t && store.place(st.notes, id, t.id, dir > 0)) { persist(); st.sel = list().findIndex((n) => n.id === id); }
  else say(t ? "Pinned notes stay on top. Unpin a note to move it between groups." : "");
}

// ---- export / import ----
function exportFlow() {
  const l = st.q || st.filter !== "all" || st.tag ? list() : store.pinFirst(st.notes);
  st.prompt = { label: "Export to (.json file, or a folder for Markdown files):", value: path.join(os.homedir(), "herdr-notes-export.json"), onSubmit: (v) => {
    const p = tilde(v.trim());
    try {
      if (p.endsWith(".json")) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, store.toJSON(l)); }
      else { fs.mkdirSync(p, { recursive: true }); for (const f of store.toMarkdownFiles(l)) fs.writeFileSync(path.join(p, f.name), f.content); }
      say(`Exported ${l.length} notes to ${p}`);
    } catch (e) { say("Export failed: " + e.message); }
  } };
}
function importFlow() {
  st.prompt = { label: "Import from (.json, .md, or a folder):", value: os.homedir() + path.sep, onSubmit: (v) => {
    const p = tilde(v.trim());
    let found = [];
    try {
      const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => /\.(md|json)$/i.test(f)).map((f) => path.join(p, f)) : [p];
      for (const f of files) found.push(...store.parseImport(fs.readFileSync(f, "utf8"), f));
    } catch (e) { return say("Import failed: " + (e.code === "ENOENT" ? "no such file or folder." : e.message)); }
    if (!found.length) return say("Nothing to import.");
    const dups = found.filter((n) => store.isDup(st.notes, n)).length;
    const apply = (mode) => () => {
      const snap = { notes: st.notes.slice(), deleted: st.deleted.slice() };
      const add = mode === "skip" ? found.filter((n) => !store.isDup(st.notes, n)) : found;
      st.notes = mode === "replace" ? add : st.notes.concat(add);
      if (mode === "replace") st.deleted = st.deleted.concat(snap.notes.map((n) => n.id));
      persist(); st.sel = 0;
      st.undo = () => { st.notes = snap.notes; st.deleted = snap.deleted.filter((id) => !snap.notes.some((n) => n.id === id)); snap.notes.forEach(touch); persist(); };
      say(`Imported ${add.length} notes. Press u to undo.`);
    };
    st.prompt = { label: `Found ${found.length} notes (${dups} already here).  s = skip duplicates, a = import all, r = replace everything`, keys: { s: apply("skip"), a: apply("all"), r: apply("replace") } };
  } };
}

// ---- views ----
function openRead(n) { st.openId = n.id; st.view = "read"; st.cur = 0; st.rtop = 0; }
function openEdit(n, fresh) {
  st.openId = n.id; st.view = "edit";
  const lines = [n.title, ...n.body.split("\n")];
  st.edit = { lines, r: fresh ? 0 : Math.min(1, lines.length - 1), c: fresh ? 0 : Array.from(lines[Math.min(1, lines.length - 1)]).length, top: 0 };
}
function syncEdit() {
  const n = note(); if (!n) return;
  const [title, ...body] = st.edit.lines;
  n.title = title; n.body = body.join("\n"); touch(n); saveSoon();
}
function leaveEdit() {
  const n = note();
  syncEdit(); clearTimeout(saveT);
  if (n && !n.title.trim() && !n.body.trim()) { st.notes = st.notes.filter((x) => x !== n); st.view = "list"; persist(); return; }
  persist(); st.view = "read"; st.cur = 0; st.rtop = 0;
}

// ---- editor ----
const cps = (s) => Array.from(s);
function edInsert(text) {
  const e = st.edit, parts = text.replace(/\r\n?/g, "\n").split("\n");
  const cur = cps(e.lines[e.r]);
  const head = cur.slice(0, e.c).join(""), tail = cur.slice(e.c).join("");
  if (parts.length === 1) { e.lines[e.r] = head + parts[0] + tail; e.c += cps(parts[0]).length; }
  else {
    const last = parts[parts.length - 1];
    e.lines.splice(e.r, 1, head + parts[0], ...parts.slice(1, -1), last + tail);
    e.r += parts.length - 1; e.c = cps(last).length;
  }
  syncEdit();
}
function cycleCheck(line) {
  const m = line.match(/^(\s*)- \[( |x)\] (.*)$/), b = line.match(/^(\s*)(.*)$/);
  if (m) return m[2] === " " ? `${m[1]}- [x] ${m[3]}` : `${m[1]}${m[3]}`;
  return `${b[1]}- [ ] ${b[2]}`;
}
function editKey(k) {
  const e = st.edit, line = () => cps(e.lines[e.r]);
  switch (k.name) {
    case "esc": case "ctrl+s": return leaveEdit();
    case "left": if (e.c > 0) e.c--; else if (e.r > 0) { e.r--; e.c = line().length; } return;
    case "right": if (e.c < line().length) e.c++; else if (e.r < e.lines.length - 1) { e.r++; e.c = 0; } return;
    case "up": if (e.r > 0) { e.r--; e.c = Math.min(e.c, line().length); } return;
    case "down": if (e.r < e.lines.length - 1) { e.r++; e.c = Math.min(e.c, line().length); } return;
    case "pgup": e.r = Math.max(0, e.r - 10); e.c = Math.min(e.c, line().length); return;
    case "pgdn": e.r = Math.min(e.lines.length - 1, e.r + 10); e.c = Math.min(e.c, line().length); return;
    case "home": case "ctrl+a": e.c = 0; return;
    case "end": case "ctrl+e": e.c = line().length; return;
    case "enter": return edInsert("\n");
    case "tab": return edInsert("  ");
    case "backspace": {
      if (e.c > 0) { const l = line(); l.splice(e.c - 1, 1); e.lines[e.r] = l.join(""); e.c--; }
      else if (e.r > 0) { const p = cps(e.lines[e.r - 1]).length; e.lines[e.r - 1] += e.lines[e.r]; e.lines.splice(e.r, 1); e.r--; e.c = p; }
      return syncEdit();
    }
    case "delete": {
      const l = line();
      if (e.c < l.length) { l.splice(e.c, 1); e.lines[e.r] = l.join(""); }
      else if (e.r < e.lines.length - 1) { e.lines[e.r] += e.lines[e.r + 1]; e.lines.splice(e.r + 1, 1); }
      return syncEdit();
    }
    case "ctrl+b": edInsert("****"); e.c -= 2; return;
    case "ctrl+l": { const l = cycleCheck(e.lines[e.r]); e.c = Math.min(cps(l).length, e.c + cps(l).length - cps(e.lines[e.r]).length); e.lines[e.r] = l; return syncEdit(); }
    case "char": return edInsert(k.ch);
    case "paste": return edInsert(k.text);
  }
}

// ---- keys ----
function promptKey(k) {
  const p = st.prompt;
  if (p.keys) { const f = k.name === "char" && p.keys[k.ch]; st.prompt = null; if (f) f(); return; }
  if (k.name === "enter") { st.prompt = null; if (p.live) return; return p.onSubmit(p.value); }
  if (k.name === "esc") { st.prompt = null; if (p.live) { st.q = p.prev; st.sel = 0; } return; }
  if (k.name === "backspace") p.value = cps(p.value).slice(0, -1).join("");
  else if (k.name === "char" || k.name === "paste") p.value += (k.ch ?? k.text).replace(/\r?\n/g, " ");
  else return;
  if (p.live) { st.q = p.value; st.sel = 0; st.scroll = 0; }
}
function noteCommon(k, n) {
  if (k.name !== "char") return false;
  switch (k.ch) {
    case "t": setStatus(n); return true;
    case "c": n.color = cycle(COLORS, n.color); touch(n); persist(); return true;
    case "p": n.pinned = !n.pinned; touch(n); persist(); if (st.view === "list") st.sel = list().findIndex((x) => x === n); return true;
    case "#": tagPrompt(n); return true;
    case "D": duePrompt(n); return true;
    case "d": confirmDelete(n); return true;
  }
  return false;
}
function key(k) {
  if (st.help) { st.help = false; return; }
  st.msg = "";
  if (k.name === "ctrl+c") return quit();
  if (st.prompt) return promptKey(k);
  if (st.view === "edit") return editKey(k);
  const n = st.view === "read" ? note() : current();
  if (k.name === "char" && k.ch === "?") { st.help = true; return; }
  if (st.view === "read") {
    const ch = k.name === "char" ? k.ch : "";
    if (k.name === "esc" || ch === "q" || k.name === "left" || ch === "h") { st.view = "list"; st.sel = Math.max(0, list().findIndex((x) => x.id === st.openId)); return; }
    if (ch === "e") return openEdit(n);
    if (k.name === "down" || ch === "j") st.cur++;
    else if (k.name === "up" || ch === "k") st.cur--;
    else if (k.name === "pgdn") st.cur += 10;
    else if (k.name === "pgup") st.cur -= 10;
    else if (k.name === "home") st.cur = 0;
    else if (k.name === "end") st.cur = 1e6;
    else if (ch === " " || k.name === "enter") toggleCheck(n);
    else noteCommon(k, n);
    return;
  }
  // list
  const l = list(), ch = k.name === "char" ? k.ch : "";
  if (k.name === "down" || ch === "j") st.sel = Math.min(l.length - 1, st.sel + 1);
  else if (k.name === "up" || ch === "k") st.sel = Math.max(0, st.sel - 1);
  else if (k.name === "home") st.sel = 0;
  else if (k.name === "end") st.sel = Math.max(0, l.length - 1);
  else if (k.name === "pgdn") st.sel = Math.min(l.length - 1, st.sel + 10);
  else if (k.name === "pgup") st.sel = Math.max(0, st.sel - 10);
  else if (k.name === "esc") { if (st.q || st.filter !== "all" || st.tag) { st.q = ""; st.filter = "all"; st.tag = ""; st.sel = 0; } else quit(); }
  else if (ch === "q") quit();
  else if (ch === "n") newNote();
  else if (ch === "/") st.prompt = { label: "Search:", value: st.q, live: true, prev: st.q };
  else if (ch === "f") { st.filter = cycle(["all", "todo", "done", "pinned"], st.filter); st.sel = 0; say("Showing: " + st.filter); }
  else if (ch === "F") { const tags = [...new Set(st.notes.flatMap((x) => x.tags))].sort(); st.tag = tags.length ? cycle(["", ...tags], st.tag) : ""; st.sel = 0; say(st.tag ? "Tag filter: #" + st.tag : "Tag filter off"); }
  else if (ch === "x") exportFlow();
  else if (ch === "i") importFlow();
  else if (ch === "u") { if (st.undo) { st.undo(); st.undo = null; say("Undone."); } else say("Nothing to undo."); }
  else if (n && (k.name === "enter" || k.name === "right" || ch === "l")) openRead(n);
  else if (n && ch === "e") openEdit(n);
  else if (n && ch === "J") reorder(n.id, 1);
  else if (n && ch === "K") reorder(n.id, -1);
  else if (n) noteCommon(k, n);
}
function toggleCheck(n) {
  const r = st.md?.[st.cur];
  if (!r || !r.chk) return;
  const L = n.body.split("\n");
  L[r.src] = /\[x\]/.test(L[r.src]) ? L[r.src].replace("[x]", "[ ]") : L[r.src].replace("[ ]", "[x]");
  n.body = L.join("\n"); touch(n); persist();
}

// ---- mouse ----
let lastClick = { id: "", t: 0 }, drag = null;
function mouse(m) {
  if (st.prompt || st.help || m.motion) return;
  const { b, x, y, up } = m;
  if (b === 64 || b === 65) {
    const d = b === 64 ? -1 : 1;
    if (st.view === "list") st.sel = Math.max(0, Math.min(list().length - 1, st.sel + d)); else if (st.view === "read") st.cur += d * 3;
    return;
  }
  if (st.view === "read" && b === 0 && !up) {
    const now = Date.now();
    if (now - lastClick.t < 400 && lastClick.id === "read") { lastClick.t = 0; return openEdit(note()); }
    lastClick = { id: "read", t: now };
    return;
  }
  if (st.view !== "list") return;
  const id = st.rowMap[y];
  if (b === 0 && !up) {
    if (!id) return;
    st.sel = list().findIndex((n) => n.id === id);
    const n = list()[st.sel];
    if (x >= 5 && x <= 8) return setStatus(n);
    const now = Date.now();
    if (lastClick.id === id && now - lastClick.t < 400) { lastClick.t = 0; return openRead(n); }
    lastClick = { id, t: now }; drag = id;
  } else if (up && drag) {
    const from = drag; drag = null;
    if (id && id !== from) {
      const l = list(), after = l.findIndex((n) => n.id === id) > l.findIndex((n) => n.id === from);
      if (store.place(st.notes, from, id, after)) { persist(); st.sel = list().findIndex((n) => n.id === from); }
      else say("Pinned notes stay on top. Unpin a note to move it between groups.");
    }
  }
}

// ---- input parsing ----
const TOK = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[200~([\s\S]*?)\x1b\[201~|\x1b\[([0-9;]*)([A-Za-z~])|\x1bO([A-Za-z])|\x1b[\s\S]|[\s\S]/yu;
const CSI = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift+tab" };
const TILDE = { 1: "home", 7: "home", 4: "end", 8: "end", 3: "delete", 5: "pgup", 6: "pgdn" };
function parse(data) {
  const evs = [];
  TOK.lastIndex = 0;
  let m;
  while (TOK.lastIndex < data.length && (m = TOK.exec(data))) {
    const t = m[0];
    if (m[4]) { evs.push({ mouse: { b: +m[1] & ~32 & ~4 & ~8 & ~16, x: +m[2], y: +m[3], up: m[4] === "m", motion: (+m[1] & 32) !== 0 } }); continue; }
    if (m[5] !== undefined) { evs.push({ name: "paste", text: m[5] }); continue; }
    if (m[7]) { const name = m[7] === "~" ? TILDE[m[6].split(";")[0]] : CSI[m[7]]; if (name) evs.push({ name }); continue; }
    if (m[8]) { const name = CSI[m[8]]; if (name) evs.push({ name }); continue; }
    if (t === "\x1b") evs.push({ name: "esc" });
    else if (t[0] === "\x1b") evs.push({ name: "esc" });
    else if (t === "\r" || t === "\n") evs.push({ name: "enter" });
    else if (t === "\x7f" || t === "\b") evs.push({ name: "backspace" });
    else if (t === "\t") evs.push({ name: "tab" });
    else if (t.charCodeAt(0) < 32) evs.push({ name: "ctrl+" + String.fromCharCode(t.charCodeAt(0) + 96) });
    else evs.push({ name: "char", ch: t });
  }
  return evs;
}

// ---- lifecycle ----
function quit() {
  clearTimeout(saveT);
  if (st.view === "edit") syncEdit();
  try { persist(); } catch {}
  out("\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  process.exit(0);
}
out("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (d) => {
  try {
    for (const ev of parse(d)) {
      if (ev.mouse) mouse(ev.mouse); else key(ev);
      if (st.view === "read") st.md = readScreen(st, process.stdout.columns || 80, process.stdout.rows || 24).md;
    }
    draw();
  } catch (e) {
    st.view = "list"; st.prompt = null; st.help = false; say("Error: " + e.message);
    try { draw(); } catch {}
  }
});
process.stdout.on("resize", draw);
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);
// Pick up changes made by other sessions (not while typing a note).
setInterval(() => {
  if (st.view === "edit" || st.prompt) return;
  const d = store.load();
  if (d.exists && d.mtime !== st.mtime) { const m = store.merge({ notes: st.notes, deleted: st.deleted }, d); st.notes = m.notes; st.deleted = m.deleted; st.mtime = d.mtime; draw(); }
}, 1500).unref();
draw();
