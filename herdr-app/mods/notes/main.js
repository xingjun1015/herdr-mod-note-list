// Notes for the Herdr app: a panel with a notes list and a note page (preview first, edit on demand).
// Notes are stored in ~/.herdr-notes/notes.json on THIS machine, the one running the app and its core.
// Remote machines' spaces use the same notes, so nothing is installed anywhere else. The Herdr terminal
// plugin (herdr-mod-note-list) reads and writes the same file.
// The layout node "notes-panel" holds this mod; the Notes button in the tab bar toggles it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor, TextView } from "gpui-base";
import { run, theme, settings, home, readTextFile, writeTextFile, pickFiles, checking, nextCommand, layout, props as blockProps } from "herdr";
import * as core from "./core.js";

const { COLORS } = core;
let rootHandle = null; // the panel root's focus handle: clicking a control gives the panel the keyboard
const stop = (_e, cx) => { cx.stop_propagation(); rootHandle?.focus(); };
const dir = () => `${home().replace(/\\/g, "/")}/.herdr-notes`;
const FILE = () => `${dir()}/notes.json`;
const nowMs = () => Date.now();
const icon = (name, size = 14) => svg(`mods/notes/${name}.svg`).size(size).flex_none();
const NC = (t, c) => ({ red: t.ansi1, green: t.ansi2, amber: t.ansi3, blue: t.ansi4, violet: t.ansi5, pink: t.ansi13, gray: t.dim })[c] ?? t.dim;
const ago = (ms) => {
  const m = Math.max(1, Math.round((nowMs() - ms) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const preview = (b) => b.replace(/```[\s\S]*?```/g, "").replace(/^#+\s*/gm, "").replace(/[`*>]|\[\[|\]\]/g, "").replace(/^\s*- (\[[ x]\] )?/gm, "").replace(/\s+/g, " ").trim();
const words = (s) => (s.match(/\S+/g) || []).length;
const cycle = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];
const tilde = (p) => (p.startsWith("~") ? home() + p.slice(1) : p);

function btn(t, id, child, onClick, o = {}) {
  return h_flex().id(id).h(o.h ?? 26).px(o.px ?? 9).gap(5).flex_none().items_center().justify_center().rounded(6).text_size(12).border(1)
    .border_color(o.primary ? t.solid : o.active ? t.accent : t.border)
    .bg(o.primary ? t.solid : o.active ? t.selected : t.chrome)
    .text_color(o.primary ? t.solid_foreground : o.danger ? t.blocked : o.active ? t.foreground : t.muted)
    .hover((s) => s.bg(o.primary ? t.solid : t.hover)).on_mouse_down("left", stop).on_click(onClick).child(child);
}
const label = (t, text) => div().text_size(11).text_color(t.dim).child(text);

// Split a note body into Markdown chunks and clickable checklist rows (checklist-looking lines inside a code fence stay text).
function blocks(body) {
  const out = []; let buf = [], fence = false;
  const flush = () => { if (buf.length) out.push({ md: buf.join("\n") }); buf = []; };
  body.split("\n").forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && l.match(/^(\s*)- \[( |x)\] (.*)$/);
    if (m) { flush(); out.push({ chk: true, i, done: m[2] === "x", text: m[3] }); } else buf.push(l);
  });
  flush();
  return out;
}

const PANEL = "notes-panel"; // the layout node this mod lives in; the toggle role shows and hides it
function findNode(n, id) {
  if (n?.id === id) return n;
  for (const c of n?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}

// Role "toggle": a Notes button for the tab bar row (a block with props { "role": "toggle" }, about 90px wide).
function toggleButton() {
  const t = theme(), node = findNode(layout(), PANEL), on = Boolean(node) && !node.hidden;
  return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-notes").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("layout.toggle", { id: PANEL })).child(svg("mods/notes/icon.svg").size(14)).child("Notes"));
}

export default class Notes extends View {
  init(_props, cx) {
    this.toggle = blockProps()?.role === "toggle";
    if (this.toggle) return;
    const t = theme();
    this.t = t;
    this.notes = []; this.deleted = []; this.raw = null; this.loaded = false; this.error = "";
    this.view = "list"; this.openId = null; this.edit = false;
    this.q = ""; this.filter = "all"; this.tag = "";
    this.colorPick = null; this.tagEdit = null; this.delId = null; this.delOpen = false;
    this.drag = null; this.over = null;
    this.msg = null; this.undo = null;
    this.dirty = false; this.saving = false; this.again = false; this.state = "saved";
    this.detailsOpen = true;
    this.handle = cx.focus_handle();
    rootHandle = this.handle;

    this.search = InputState.new({ placeholder: "Search notes" });
    this.search.on("change", (_e, cx) => { this.q = this.search.value(); cx.notify(); });
    this.tagIn = InputState.new({ placeholder: "tag, then enter" });
    this.tagIn.on("submit", (_e, cx) => this.addTag(cx));
    this.title = InputState.new({ placeholder: "Untitled note" });
    this.title.on("change", (_e, cx) => this.onTitle(cx));
    this.due = InputState.new({ placeholder: "YYYY-MM-DD" });
    this.due.on("submit", (_e, cx) => this.setDue(cx));
    this.due.on("blur", (_e, cx) => this.setDue(cx));
    const syntax = { heading: t.accent, strong: t.foreground, emphasis: t.muted, code: t.ansi3, quote: t.dim, list: t.accent, link: t.ansi4 };
    const font = settings().font_family;
    const ed = (extra = {}) => EditorState.new({ language: "markdown", value: "", line_numbers: false, folding: false, soft_wrap: true, syntax, ...(font ? { font_family: font } : {}), ...extra });
    this.editor = ed();
    this.editor.on("change", (_e, cx) => this.onBody(cx));
    this.E = { fmt: "json", scope: "all", path: "", confirm: false, result: "" };
    this.exView = ed({ readonly: true, language: "json" });
    this.exPath = InputState.new({ placeholder: "Where to save" });
    this.exPath.on("change", () => { this.E.path = this.exPath.value(); this.E.confirm = false; });
    this.I = { mode: "skip", info: null, result: "" };
    this.imText = ed({ language: "json" });
    this.imText.on("change", (_e, cx) => { this.parseImportText(); cx.notify(); });
    this.imPath = InputState.new({ placeholder: "Path of a .json or .md file" });

    if (checking()) return;
    // Commands from keys.json, the palette and `herdr-app do notes.<command>`: new, paste, open (the first note), export, import, back, focus.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") this.newNote(cx); else if (c === "export") this.openExport(cx); else if (c === "import") this.openImport(cx);
        else if (c === "back") this.back(cx); else if (c === "focus") this.handle.focus();
        else if (c === "paste") this.pasteClipboard(cx);
        else if (c === "open") { const n = this.list()[0]; if (n) this.openNote(n.id, cx); }
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      await this.reload(cx);
      let tick = 0;
      for (;;) {
        await cx.sleep(600);
        tick++;
        if (this.dirty) { this.dirty = false; this.queue(cx); }
        if (this.msg && nowMs() - this.msg.at > (this.msg.undo ? 7000 : 3000)) { this.msg = null; cx.notify(); }
        if (tick % 4 === 0 && !this.edit && !this.saving) await this.reload(cx);
      }
    });
  }

  // ---- storage ----
  async reload(cx) {
    const raw = await readTextFile(FILE()).catch(() => null);
    if (this.loaded && raw === this.raw) return;
    try {
      const d = core.parseFile(raw);
      if (!this.loaded) {
        this.notes = d.notes; this.deleted = d.deleted;
        if (raw === null) { this.notes = core.welcome(); this.raw = null; this.loaded = true; this.queue(cx); cx.notify(); return; }
      } else {
        const m = core.merge({ notes: this.notes, deleted: this.deleted }, d);
        this.notes = m.notes; this.deleted = m.deleted;
      }
      this.raw = raw; this.loaded = true; this.error = "";
    } catch (e) {
      this.error = "notes.json is not valid JSON. Fix or move it, then reopen Notes. Nothing was overwritten.";
    }
    cx.notify();
  }

  // Write with compare-and-swap. If another session (the terminal plugin) wrote meanwhile, merge and retry.
  async save() {
    for (let i = 0; i < 4; i++) {
      const cur = await readTextFile(FILE()).catch(() => null);
      if (cur !== this.raw && cur !== null) {
        try { const m = core.merge({ notes: this.notes, deleted: this.deleted }, core.parseFile(cur)); this.notes = m.notes; this.deleted = m.deleted; }
        catch { this.error = "notes.json changed and is not valid JSON; not saved."; return false; }
      }
      const text = core.fileText({ notes: this.notes, deleted: this.deleted });
      try { await writeTextFile(FILE(), text, cur); this.raw = text; return true; } catch { /* stale: read again */ }
    }
    return false;
  }

  queue(cx) {
    if (this.saving) { this.again = true; return; }
    this.saving = true; this.state = "saving";
    cx.spawn(async (cx) => {
      let ok = true;
      do { this.again = false; ok = await this.save(); } while (this.again);
      this.saving = false; this.state = ok ? "saved" : "failed";
      cx.notify();
    });
  }

  note() { return this.notes.find((n) => n.id === this.openId) ?? null; }
  list() { return core.visible(this.notes, { q: this.q, filter: this.filter, tag: this.tag }); }
  touch(n, cx) { n.upd = nowMs(); this.queue(cx); }
  say(text, cx, undo = null) { this.msg = { text, at: nowMs(), undo }; cx.notify(); }

  // ---- actions on notes ----
  newNote(cx) {
    const n = core.norm({ title: "", body: "", color: "gray" });
    this.notes.unshift(n);
    this.openNote(n.id, cx, true);
    this.queue(cx);
  }
  openNote(id, cx, edit = false) {
    this.openId = id; this.view = "detail"; this.delOpen = false;
    const n = this.note(); if (!n) return;
    this.due.set_value(n.due);
    if (edit) this.startEdit(cx, !n.title && !n.body); else { this.edit = false; this.handle.focus(); }
    cx.notify();
  }
  startEdit(cx, focusTitle = false) {
    const n = this.note(); if (!n) return;
    this.edit = true;
    this.title.set_value(n.title); this.editor.set_value(n.body);
    if (focusTitle) this.title.focus(); else this.editor.focus();
    cx.notify();
  }
  stopEdit(cx) {
    const n = this.note();
    this.edit = false;
    if (n && !n.title.trim() && !n.body.trim()) { this.removeNote(n, cx, true); return; }
    this.dirty = false; this.queue(cx); this.handle.focus(); cx.notify();
  }
  back(cx) {
    if (this.edit) this.stopEdit(cx);
    if (this.view === "detail" || this.view === "export" || this.view === "import") { this.view = "list"; this.openId = null; this.delOpen = false; }
    cx.notify();
  }
  onTitle(cx) { const n = this.note(); if (!n || !this.edit || n.title === this.title.value()) return; n.title = this.title.value(); n.upd = nowMs(); this.dirty = true; this.state = "editing"; cx.notify(); }
  onBody(cx) { const n = this.note(); if (!n || !this.edit || n.body === this.editor.value()) return; n.body = this.editor.value(); n.upd = nowMs(); this.dirty = true; this.state = "editing"; cx.notify(); }
  cycleStatus(n, cx) { n.status = cycle(core.STATUSES, n.status); this.touch(n, cx); cx.notify(); }
  setStatus(n, s, cx) { n.status = s; this.touch(n, cx); cx.notify(); }
  setColor(n, c, cx) { n.color = c; this.colorPick = null; this.touch(n, cx); cx.notify(); }
  togglePin(n, cx) { n.pinned = !n.pinned; this.touch(n, cx); cx.notify(); }
  addTag(cx) {
    const n = this.note() ?? this.notes.find((x) => x.id === this.tagEdit); if (!n) return;
    const tg = this.tagIn.value().trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
    this.tagIn.set_value("");
    if (tg && !n.tags.includes(tg)) { n.tags.push(tg); this.touch(n, cx); }
    this.tagEdit = null; cx.notify();
  }
  removeTag(n, tg, cx) { n.tags = n.tags.filter((x) => x !== tg); this.touch(n, cx); cx.notify(); }
  setDue(cx) {
    const n = this.note(); if (!n) return;
    const v = this.due.value().trim();
    if (v === n.due) return;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { this.say("Use the format YYYY-MM-DD.", cx); return; }
    n.due = v; this.touch(n, cx); cx.notify();
  }
  removeNote(n, cx, quiet = false) {
    const i = this.notes.indexOf(n); if (i < 0) return;
    this.notes.splice(i, 1); this.deleted.push(n.id); this.queue(cx);
    this.delId = null; this.delOpen = false; this.edit = false;
    if (this.view === "detail") { this.view = "list"; this.openId = null; }
    if (!quiet) this.say(`Deleted "${n.title || "Untitled"}".`, cx, () => {
      this.notes.splice(Math.min(i, this.notes.length), 0, n); this.deleted = this.deleted.filter((x) => x !== n.id); n.upd = nowMs(); this.queue(cx); cx.notify();
    });
    cx.notify();
  }
  duplicate(n, cx) {
    const c = core.norm({ ...n, id: undefined, title: `${n.title || "Untitled"} (copy)`, upd: nowMs() });
    this.notes.splice(this.notes.indexOf(n) + 1, 0, c); this.queue(cx); this.say(`Duplicated as "${c.title}".`, cx);
  }
  toggleLine(i, cx) {
    const n = this.note(); if (!n) return;
    const L = n.body.split("\n");
    L[i] = /\[x\]/.test(L[i]) ? L[i].replace("[x]", "[ ]") : L[i].replace("[ ]", "[x]");
    n.body = L.join("\n");
    if (this.edit) this.editor.set_value(n.body);
    this.touch(n, cx); cx.notify();
  }
  drop(cx) {
    const d = this.drag, o = this.over;
    this.drag = null; this.over = null;
    if (!d || !o) { cx.notify(); return; }
    if (!core.place(this.notes, d, o.id, o.after)) { this.say("Pinned notes stay on top. Unpin a note to move it between groups.", cx); return; }
    this.queue(cx); cx.notify();
  }

  // Paste while the panel itself has the keyboard (no text field): the list makes a new note,
  // a note page appends to its content on a new line.
  pasteClipboard(cx) {
    const text = cx.read_from_clipboard();
    if (!text || !text.trim()) { this.say("The clipboard has no text.", cx); return; }
    if (this.view === "list") {
      const n = core.norm({ title: `Note #${this.notes.length + 1}`, body: text, color: "gray" });
      this.notes.unshift(n); this.queue(cx);
      this.say(`Pasted into a new note: ${n.title}`, cx, () => {
        const i = this.notes.indexOf(n); if (i < 0) return;
        this.notes.splice(i, 1); this.deleted.push(n.id); this.queue(cx); cx.notify();
      });
    } else if (this.view === "detail") {
      const n = this.note(); if (!n) return;
      n.body = n.body.trim() ? n.body.replace(/\n+$/, "") + "\n" + text : text;
      if (this.edit) this.editor.set_value(n.body);
      this.touch(n, cx); this.say("Pasted onto the end of the note.", cx);
    }
  }

  // ---- editor helpers (UTF-16 offsets) ----
  wrap(pre, post, ph, cx) {
    const v = this.editor.value(), r = this.editor.selected_range(), sel = v.slice(r.start, r.end) || ph;
    this.editor.replace(pre + sel + post);
    const s = r.start + pre.length;
    this.editor.set_selected_range({ start: s, end: s + sel.length });
    this.editor.focus();
  }
  prefix(p) {
    const v = this.editor.value(), r = this.editor.selected_range(), ls = v.lastIndexOf("\n", r.start - 1) + 1;
    this.editor.set_selected_range({ start: ls, end: ls });
    this.editor.replace(p);
    this.editor.set_selected_range({ start: r.start + p.length, end: r.end + p.length });
    this.editor.focus();
  }

  // ---- export / import ----
  exportList() { return this.E.scope === "all" ? core.pinFirst(this.notes) : this.list(); }
  exportText() { const l = this.exportList(); return this.E.fmt === "json" ? core.toJSON(l) : core.toMarkdownBundle(l); }
  openExport(cx) {
    this.view = "export"; this.E.result = ""; this.E.confirm = false;
    this.E.path = `${home().replace(/\\/g, "/")}/herdr-notes-export.${this.E.fmt === "json" ? "json" : "md"}`;
    this.exPath.set_value(this.E.path);
    this.refreshExport(); cx.notify();
  }
  refreshExport() {
    this.exView.set_value(this.exportText());
  }
  setExport(patch, cx) {
    const old = this.E.fmt;
    Object.assign(this.E, patch, { confirm: false, result: "" });
    if (patch.fmt && patch.fmt !== old && /herdr-notes-export\.(json|md)$/.test(this.E.path)) {
      this.E.path = this.E.path.replace(/\.(json|md)$/, patch.fmt === "json" ? ".json" : ".md"); this.exPath.set_value(this.E.path);
    }
    this.refreshExport(); cx.notify();
  }
  saveExport(cx) {
    const path = tilde(this.exPath.value().trim()); if (!path) return;
    const text = this.exportText(), n = this.exportList().length;
    cx.spawn(async (cx) => {
      try {
        const cur = await readTextFile(path).catch(() => null);
        if (cur !== null && !this.E.confirm) { this.E.confirm = true; this.E.result = "That file exists. Press Replace file to overwrite it."; cx.notify(); return; }
        await writeTextFile(path, text, cur);
        this.E.confirm = false; this.E.result = `Saved ${n} notes to ${path}`;
      } catch (e) { this.E.result = `Could not save: ${String(e.message ?? e)}`; }
      cx.notify();
    });
  }
  openImport(cx) { this.view = "import"; this.I = { mode: "skip", info: null, result: "" }; this.imText.set_value(""); this.imPath.set_value(""); cx.notify(); }
  parseImportText() {
    const text = this.imText.value();
    if (!text.trim()) { this.I.info = null; return; }
    try { const list = core.parseImport(text, ""); this.I.info = { list, dups: list.filter((n) => core.isDup(this.notes, n)).length }; }
    catch (e) { this.I.info = { err: String(e.message ?? e) }; }
  }
  loadImport(path, cx) {
    const p = tilde(path.trim()); if (!p) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(p).catch(() => null);
      if (text === null) this.I.result = "Could not read that file (missing, or larger than 1 MB).";
      else { this.I.result = ""; this.imText.set_value(text); this.parseImportText(); }
      cx.notify();
    });
  }
  pickImport(cx) {
    cx.spawn(async (cx) => {
      let files = null;
      try { files = await pickFiles({ prompt: "Import", multiple: false }); } catch (e) { this.I.result = String(e.message ?? e); }
      if (files && files[0]) { this.imPath.set_value(files[0]); this.loadImport(files[0], cx); }
      cx.notify();
    });
  }
  applyImport(cx) {
    const info = this.I.info; if (!info || !info.list) return;
    const snap = { notes: this.notes.slice(), deleted: this.deleted.slice() }, mode = this.I.mode;
    const add = (mode === "skip" ? info.list.filter((n) => !core.isDup(this.notes, n)) : info.list).map((n) => ({ ...n, id: core.newId() }));
    if (mode === "replace") { this.deleted = this.deleted.concat(this.notes.map((n) => n.id)); this.notes = add; } else this.notes = this.notes.concat(add);
    this.queue(cx);
    this.view = "list";
    this.say(`${mode === "replace" ? "Replaced all notes with" : "Imported"} ${add.length} notes.`, cx, () => {
      this.notes = snap.notes; this.deleted = snap.deleted.filter((id) => !snap.notes.some((n) => n.id === id)); snap.notes.forEach((n) => { n.upd = nowMs(); }); this.queue(cx); cx.notify();
    });
  }

  // ---- views ----
  header(t, title, left, right) {
    return h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .children(left ? [left] : [])
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(title))
      .children(right);
  }

  renderList(t, cx) {
    const list = this.list(), filtered = this.q || this.filter !== "all" || this.tag;
    const todo = this.notes.filter((n) => n.status === "todo").length;
    const count = (f) => this.notes.filter(f).length;
    const chips = [["all", "All", this.notes.length], ["todo", "Todo", todo], ["done", "Done", count((n) => n.status === "done")], ["pinned", "Pinned", count((n) => n.pinned)]];
    const tags = [...new Set(this.notes.flatMap((n) => n.tags))].sort();
    const chip = (id, text, on, fn) => div().id(id).h(22).px(9).flex().items_center().rounded(11).text_size(11.5).border(1).flex_none()
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(fn).child(text);
    const hasPin = list.some((n) => n.pinned);
    const rows = [];
    list.forEach((n, i) => {
      if (hasPin && (i === 0 || list[i - 1].pinned !== n.pinned)) rows.push(div().px(12).py(4).text_size(10.5).text_color(t.dim).bg(t.surface).child(n.pinned ? "PINNED (ALWAYS ON TOP)" : "OTHER NOTES"));
      rows.push(this.row(t, n, cx, filtered));
    });
    if (!list.length) rows.push(v_flex().p(24).gap(6).items_center().text_color(t.muted)
      .child(filtered ? "No notes match." : "No notes yet.")
      .child(btn(t, "empty-act", filtered ? "Clear search and filters" : "Write your first note", filtered ? (_e, cx) => { this.q = ""; this.search.set_value(""); this.filter = "all"; this.tag = ""; cx.notify(); } : (_e, cx) => this.newNote(cx), { primary: !filtered })));
    return [
      this.header(t, "Notes", null, [
        div().text_size(11).text_color(t.dim).child(`${list.length}/${this.notes.length} · ${todo} todo`),
        btn(t, "imp", icon("import"), (_e, cx) => this.openImport(cx), { px: 6 }),
        btn(t, "exp", icon("export"), (_e, cx) => this.openExport(cx), { px: 6 }),
        btn(t, "new", h_flex().gap(4).items_center().child(icon("plus", 13)).child("New"), (_e, cx) => this.newNote(cx), { primary: true }),
      ]),
      h_flex().h(38).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(icon("search", 13).text_color(t.dim))
        .child(Input.new(this.search).flex_1().min_w(0).h_full().text_size(12.5).text_color(t.foreground))
        .when(Boolean(this.q), (el) => el.child(btn(t, "clear-q", icon("x", 12), (_e, cx) => { this.q = ""; this.search.set_value(""); cx.notify(); }, { px: 4, h: 22 }))),
      h_flex().flex_none().px(10).py(7).gap(5).items_center().flex_wrap().border_b(1).border_color(t.border)
        .children(chips.map(([id, text, n]) => chip(`f-${id}`, `${text} ${n}`, this.filter === id, (_e, cx) => { this.filter = id; cx.notify(); })))
        .children(tags.map((g) => chip(`g-${g}`, `#${g}`, this.tag === g, (_e, cx) => { this.tag = this.tag === g ? "" : g; cx.notify(); }))),
      div().id("list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().children(rows)),
      h_flex().h(26).flex_none().px(12).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(filtered ? "Filtered view: clear it to drag-reorder" : "Drag the grip to reorder · stored on this machine, shared with all sessions")),
    ];
  }

  row(t, n, cx, filtered) {
    const c = NC(t, n.color), over = this.over && this.over.id === n.id && this.drag && this.drag !== n.id;
    const box = n.status === "done" ? div().size(18).rounded(4).flex().items_center().justify_center().bg(c).text_color(t.background).child(svg("mods/notes/check.svg").size(12))
      : n.status === "todo" ? div().size(18).rounded(4).border(1.5).border_color(c)
      : div().size(18).rounded(4).border(1).border_color(t.border);
    const sub = this.delId === n.id
      ? h_flex().gap(8).items_center().pt(6).child(div().text_size(12).text_color(t.muted).child("Delete this note?"))
          .child(btn(t, `del-yes-${n.id}`, "Delete", (_e, cx) => this.removeNote(n, cx), { danger: true, h: 24 })).child(btn(t, `del-no-${n.id}`, "Keep", (_e, cx) => { this.delId = null; cx.notify(); }, { h: 24 }))
      : this.colorPick === n.id
      ? h_flex().gap(7).items_center().pt(6).children(COLORS.map((k) => div().id(`c-${n.id}-${k}`).size(18).rounded(9).bg(NC(t, k)).border(2).border_color(k === n.color ? t.foreground : t.chrome)
          .on_mouse_down("left", stop).on_click((_e, cx) => this.setColor(n, k, cx))))
      : this.tagEdit === n.id
      ? h_flex().gap(6).items_center().pt(6).child(Input.new(this.tagIn).w(140).h(24).text_size(12).text_color(t.foreground))
          .child(btn(t, `tag-ok-${n.id}`, "Add", (_e, cx) => this.addTag(cx), { h: 24 })).child(btn(t, `tag-no-${n.id}`, "Cancel", (_e, cx) => { this.tagEdit = null; cx.notify(); }, { h: 24 }))
      : null;
    return v_flex().id(`row-${n.id}`).px(8).py(7).border_b(1).border_color(t.border).bg(t.chrome).hover((s) => s.bg(t.hover))
      .when(over && this.over.after, (el) => el.border_b(2).border_color(t.accent))
      .when(over && !this.over.after, (el) => el.border_t(2).border_color(t.accent))
      .when(this.drag === n.id, (el) => el.opacity(0.4))
      .on_mouse_move((e, cx) => {
        if (!this.drag || this.drag === n.id) return;
        const after = e.local_position.y > e.bounds.height / 2;
        if (!this.over || this.over.id !== n.id || this.over.after !== after) { this.over = { id: n.id, after }; cx.notify(); }
      })
      .on_click((_e, cx) => { if (this.delId !== n.id) this.openNote(n.id, cx); })
      .child(h_flex().gap(8).items_start()
        .child(div().id(`grip-${n.id}`).w(16).h(20).flex_none().flex().items_center().justify_center().text_color(filtered ? t.border : t.dim).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!filtered) { this.drag = n.id; cx.notify(); } }).child(icon("grip", 12)))
        .child(div().w(3).h(32).flex_none().rounded(2).bg(c))
        .child(div().id(`box-${n.id}`).flex_none().pt(1).on_mouse_down("left", stop).on_click((_e, cx) => this.cycleStatus(n, cx)).child(box))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().truncate().font_semibold().text_color(n.status === "done" ? t.dim : t.foreground).when(n.status === "done", (el) => el.line_through()).child(n.title || "Untitled"))
            .when(n.pinned, (el) => el.child(icon("pin", 11).text_color(t.ansi3)))
            .when(Boolean(n.due) && n.status !== "done", (el) => el.child(div().text_size(10.5).text_color(t.dim).flex_none().child(`due ${n.due.slice(5)}`))))
          .child(div().truncate().text_size(12).text_color(t.muted).child(preview(n.body)))
          .child(h_flex().gap(5).items_center().flex_wrap().pt(1)
            .children(n.tags.map((g) => div().id(`t-${n.id}-${g}`).px(7).text_size(10.5).rounded(9).border(1).border_color(t.border).text_color(t.muted).hover((s) => s.text_color(t.foreground))
              .on_mouse_down("left", stop).on_click((_e, cx) => { this.tag = g; cx.notify(); }).child(`#${g}`)))
            .child(div().id(`addtag-${n.id}`).px(7).text_size(10.5).rounded(9).border(1).border_color(t.border).text_color(t.dim).hover((s) => s.text_color(t.foreground))
              .on_mouse_down("left", stop).on_click((_e, cx) => { this.tagEdit = n.id; this.tagIn.set_value(""); cx.notify(); this.tagIn.focus(); }).child("+ tag")))
          .children(sub ? [sub] : []))
        .child(v_flex().flex_none().items_end().gap(2)
          .child(h_flex().gap(2)
            .child(div().id(`color-${n.id}`).size(22).flex().items_center().justify_center().rounded(5).hover((s) => s.bg(t.raised)).on_mouse_down("left", stop)
              .on_click((_e, cx) => { this.colorPick = this.colorPick === n.id ? null : n.id; cx.notify(); }).child(div().size(11).rounded(6).bg(c)))
            .child(div().id(`pin-${n.id}`).size(22).flex().items_center().justify_center().rounded(5).hover((s) => s.bg(t.raised)).text_color(n.pinned ? t.ansi3 : t.dim)
              .on_mouse_down("left", stop).on_click((_e, cx) => this.togglePin(n, cx)).child(icon("pin", 13)))
            .child(div().id(`trash-${n.id}`).size(22).flex().items_center().justify_center().rounded(5).hover((s) => s.bg(t.raised)).text_color(t.dim)
              .on_mouse_down("left", stop).on_click((_e, cx) => { this.delId = n.id; cx.notify(); }).child(icon("trash", 13))))
          .child(div().text_size(10.5).text_color(t.dim).child(ago(n.upd)))));
  }

  renderDetail(t, cx) {
    const n = this.note();
    if (!n) return [this.header(t, "Note not found", btn(t, "bk", icon("back"), (_e, cx) => this.back(cx), { px: 6 }), []), div().p(16).text_color(t.muted).child("This note was deleted in another session.")];
    const c = NC(t, n.color);
    const tot = (n.body.match(/^\s*- \[[ x]\]/gm) || []).length, dn = (n.body.match(/^\s*- \[x\]/gm) || []).length;
    const props = v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().id("details-head").h(30).px(12).gap(6).items_center().text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.detailsOpen = !this.detailsOpen; cx.notify(); }).child(icon("chevron", 12)).child("DETAILS")
        .child(div().flex_1()).when(tot > 0, (el) => el.child(div().child(`${dn}/${tot} done`))))
      .when(this.detailsOpen, (el) => el.child(v_flex().px(12).pb(10).gap(8)
        .child(h_flex().gap(8).items_center().flex_wrap().child(label(t, "Status"))
          .children(["none", "todo", "done"].map((s) => btn(t, `st-${s}`, s === "none" ? "None" : s === "todo" ? "Todo" : "Done", (_e, cx) => this.setStatus(n, s, cx), { active: n.status === s, h: 24 })))
          .child(btn(t, "pinb", h_flex().gap(4).items_center().child(icon("pin", 12)).child(n.pinned ? "Pinned" : "Pin"), (_e, cx) => this.togglePin(n, cx), { active: n.pinned, h: 24 })))
        .child(h_flex().gap(8).items_center().child(label(t, "Color"))
          .children(COLORS.map((k) => div().id(`dc-${k}`).size(18).rounded(9).bg(NC(t, k)).border(2).border_color(k === n.color ? t.foreground : t.chrome).on_mouse_down("left", stop).on_click((_e, cx) => this.setColor(n, k, cx))))
          .child(div().w(10)).child(label(t, "Due")).child(Input.new(this.due).w(110).h(24).text_size(12).text_color(t.foreground)))
        .child(h_flex().gap(6).items_center().flex_wrap().child(label(t, "Tags"))
          .children(n.tags.map((g) => h_flex().id(`dt-${g}`).gap(4).h(22).px(8).items_center().rounded(11).border(1).border_color(t.border).text_size(11.5).text_color(t.muted)
            .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => this.removeTag(n, g, cx)).child(`#${g}`).child(icon("x", 10))))
          .child(Input.new(this.tagIn).w(120).h(24).text_size(12).text_color(t.foreground))
          .child(btn(t, "tag-add", "Add", (_e, cx) => this.addTag(cx), { h: 24 })))));
    const body = this.edit
      ? v_flex().flex_1().min_h(0)
          .child(div().px(12).pt(10).child(Input.new(this.title).h(32).text_size(17).font_semibold().text_color(t.foreground)))
          .child(h_flex().flex_none().px(10).py(6).gap(4).flex_wrap().items_center().border_b(1).border_color(t.border)
            .children([["H1", (_e, cx) => this.prefix("# ")], ["H2", (_e, cx) => this.prefix("## ")], ["H3", (_e, cx) => this.prefix("### ")], ["B", (_e, cx) => this.wrap("**", "**", "bold", cx)], ["I", (_e, cx) => this.wrap("*", "*", "italic", cx)],
              ["code", (_e, cx) => this.wrap("`", "`", "code", cx)], ["list", (_e, cx) => this.prefix("- ")], ["task", (_e, cx) => this.prefix("- [ ] ")], ["quote", (_e, cx) => this.prefix("> ")], ["block", (_e, cx) => this.wrap("\n```\n", "\n```\n", "command", cx)], ["[[ ]]", (_e, cx) => this.wrap("[[", "]]", "note", cx)]]
              .map(([l, f]) => btn(t, `tb-${l}`, l, f, { h: 24, px: 7 }))))
          .child(div().flex_1().min_h(0).px(8).child(Editor.new(this.editor).size_full()))
      : div().id("preview").flex_1().min_h(0).overflow_y_scrollbar().on_mouse_down("left", (e, cx) => { if (e.click_count === 2) this.startEdit(cx); })
          .child(v_flex().p(14).gap(6)
            .child(div().text_size(19).font_semibold().child(n.title || "Untitled"))
            .child(h_flex().gap(8).items_center().flex_wrap().text_size(11.5).text_color(t.dim)
              .child(n.status !== "none" ? div().px(7).rounded(9).border(1).border_color(c).text_color(c).child(n.status) : div())
              .child(`edited ${ago(n.upd)} ago`).child(`${words(n.body)} words`).when(Boolean(n.due), (el) => el.child(`due ${n.due}`)))
            .children(blocks(n.body).map((b, i) => b.chk
              ? h_flex().id(`chk-${b.i}`).gap(8).items_start().py(2).on_mouse_down("left", stop).on_click((_e, cx) => this.toggleLine(b.i, cx))
                  .child(div().size(16).flex_none().mt(2).rounded(4).border(1).border_color(b.done ? c : t.input).bg(b.done ? c : t.chrome).flex().items_center().justify_center().text_color(t.background)
                    .when(b.done, (el) => el.child(svg("mods/notes/check.svg").size(11))))
                  .child(div().flex_1().min_w(0).text_color(b.done ? t.dim : t.foreground).when(b.done, (el) => el.line_through()).child(b.text.replace(/[*`]/g, "")))
              : div().min_w(0).child(TextView.markdown(`md-${i}`, b.md))))
            .when(!n.body.trim(), (el) => el.child(div().text_color(t.dim).child("Empty note. Press Edit to write.")))
            .child(div().pt(6).text_size(11).text_color(t.dim).child("Double-click the text to edit.")));
    return [
      h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(btn(t, "bk", h_flex().gap(3).items_center().child(icon("back")).child("Notes"), (_e, cx) => this.back(cx), { px: 6 }))
        .child(div().w(3).h(18).rounded(2).bg(c))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(n.title || "Untitled"))
        .child(div().text_size(11).text_color(this.state === "failed" ? t.blocked : t.dim).child(this.state === "saved" ? "Saved" : this.state === "saving" ? "Saving..." : this.state === "editing" ? "Editing" : "Not saved"))
        .child(this.edit ? btn(t, "done", "Done", (_e, cx) => this.stopEdit(cx), { primary: true }) : btn(t, "edit", h_flex().gap(4).items_center().child(icon("edit", 13)).child("Edit"), (_e, cx) => this.startEdit(cx), { primary: true })),
      props,
      body,
      h_flex().h(34).flex_none().px(10).gap(6).items_center().border_t(1).border_color(t.border)
        .child(btn(t, "copy", "Copy markdown", (_e, cx) => { cx.write_to_clipboard(n.body); this.say("Copied the note as markdown.", cx); }, { h: 24 }))
        .child(btn(t, "dup", "Duplicate", (_e, cx) => this.duplicate(n, cx), { h: 24 }))
        .child(div().flex_1())
        .child(this.delOpen ? h_flex().gap(6).items_center().child(div().text_size(12).text_color(t.muted).child("Delete this note?"))
              .child(btn(t, "d-yes", "Delete", (_e, cx) => this.removeNote(n, cx), { danger: true, h: 24 })).child(btn(t, "d-no", "Keep", (_e, cx) => { this.delOpen = false; cx.notify(); }, { h: 24 }))
          : btn(t, "d-open", h_flex().gap(4).items_center().child(icon("trash", 12)).child("Delete"), (_e, cx) => { this.delOpen = true; cx.notify(); }, { h: 24, danger: true })),
    ];
  }

  seg(t, id, opts, cur, fn) {
    return h_flex().children(opts.map(([v, l], i) => div().id(`${id}-${v}`).h(24).px(10).flex().items_center().text_size(12).border(1)
      .border_color(cur === v ? t.accent : t.border).bg(cur === v ? t.selected : t.chrome).text_color(cur === v ? t.foreground : t.muted)
      .rounded_l(i === 0 ? 6 : 0).rounded_r(i === opts.length - 1 ? 6 : 0).on_mouse_down("left", stop).on_click((_e, cx) => fn(v, cx)).child(l)));
  }

  renderExport(t, cx) {
    const l = this.exportList();
    return [
      this.header(t, "Export notes", btn(t, "bk", h_flex().gap(3).items_center().child(icon("back")).child("Notes"), (_e, cx) => this.back(cx), { px: 6 }), []),
      v_flex().flex_1().min_h(0).p(12).gap(10)
        .child(h_flex().gap(8).items_center().flex_wrap().child(label(t, "Format"))
          .child(this.seg(t, "fmt", [["json", "JSON (re-importable)"], ["md", "Markdown (one file)"]], this.E.fmt, (v, cx) => this.setExport({ fmt: v }, cx))))
        .child(h_flex().gap(8).items_center().flex_wrap().child(label(t, "Notes"))
          .child(this.seg(t, "scope", [["all", `All (${this.notes.length})`], ["view", `Current list (${this.list().length})`]], this.E.scope, (v, cx) => this.setExport({ scope: v }, cx))))
        .child(div().flex_1().min_h(0).rounded(6).border(1).border_color(t.border).p(4).child(Editor.new(this.exView).size_full()))
        .child(h_flex().gap(8).items_center().child(label(t, "Save to")).child(Input.new(this.exPath).flex_1().min_w(0).h(26).text_size(12).text_color(t.foreground)))
        .child(div().text_size(11).text_color(t.dim).child("The file is written on this machine, the one running Herdr."))
        .children(this.E.result ? [div().text_size(12).text_color(this.E.result.startsWith("Saved") ? t.done : t.ansi3).child(this.E.result)] : [])
        .child(h_flex().gap(8).justify_end().child(btn(t, "ex-copy", "Copy to clipboard", (_e, cx) => { cx.write_to_clipboard(this.exportText()); this.E.result = `Copied ${l.length} notes.`; cx.notify(); }))
          .child(btn(t, "ex-save", this.E.confirm ? "Replace file" : "Save file", (_e, cx) => this.saveExport(cx), { primary: true }))),
    ];
  }

  renderImport(t, cx) {
    const info = this.I.info;
    const summary = !info ? "Choose a file, or paste exported JSON or Markdown below."
      : info.err ? info.err : `Found ${info.list.length} notes: ${info.list.length - info.dups} new, ${info.dups} already here.`;
    return [
      this.header(t, "Import notes", btn(t, "bk", h_flex().gap(3).items_center().child(icon("back")).child("Notes"), (_e, cx) => this.back(cx), { px: 6 }), []),
      v_flex().flex_1().min_h(0).p(12).gap(10)
        .child(h_flex().gap(8).items_center().child(btn(t, "im-pick", "Choose file...", (_e, cx) => this.pickImport(cx)))
          .child(Input.new(this.imPath).flex_1().min_w(0).h(26).text_size(12).text_color(t.foreground))
          .child(btn(t, "im-load", "Load", (_e, cx) => this.loadImport(this.imPath.value(), cx))))
        .child(div().flex_1().min_h(0).rounded(6).border(1).border_color(t.border).p(4).child(Editor.new(this.imText).size_full()))
        .child(div().text_size(12).text_color(info && info.err ? t.blocked : t.muted).child(this.I.result || summary))
        .child(h_flex().gap(8).items_center().flex_wrap().child(label(t, "If a note already exists"))
          .child(this.seg(t, "imode", [["skip", "Skip it"], ["all", "Import as new"], ["replace", "Replace all"]], this.I.mode, (v, cx) => { this.I.mode = v; cx.notify(); })))
        .child(h_flex().gap(8).justify_end().child(btn(t, "im-cancel", "Cancel", (_e, cx) => this.back(cx)))
          .child(btn(t, "im-go", "Import", (_e, cx) => this.applyImport(cx), { primary: Boolean(info && info.list) }))),
    ];
  }

  render(cx) {
    if (this.toggle) return toggleButton();
    const t = theme();
    this.t = t;
    let parts;
    if (this.error) parts = [this.header(t, "Notes", null, []), v_flex().p(16).gap(8).child(div().text_color(t.blocked).child(this.error))];
    else if (!this.loaded) parts = [this.header(t, "Notes", null, []), div().p(16).text_color(t.dim).child("Loading notes...")];
    else if (this.view === "detail") parts = this.renderDetail(t, cx);
    else if (this.view === "export") parts = this.renderExport(t, cx);
    else if (this.view === "import") parts = this.renderImport(t, cx);
    else parts = this.renderList(t, cx);
    return v_flex().id("notes-root").track_focus(this.handle).size_full().min_w(0).bg(t.chrome).text_size(13).text_color(t.foreground)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if ((e.keystroke === "cmd-v" || e.keystroke === "ctrl-v" || e.keystroke === "shift-insert") && this.handle.is_focused() && (this.view === "list" || this.view === "detail")) { this.pasteClipboard(cx); cx.stop_propagation(); return; }
        if (e.key === "escape") { if (this.view !== "list" || this.edit) { this.back(cx); cx.stop_propagation(); } else if (this.colorPick || this.delId || this.tagEdit) { this.colorPick = this.delId = this.tagEdit = null; cx.notify(); cx.stop_propagation(); } }
        else if (e.keystroke === "cmd-s") { this.dirty = false; this.queue(cx); cx.stop_propagation(); }
        else if (this.edit && e.keystroke === "cmd-b") { this.wrap("**", "**", "bold", cx); cx.stop_propagation(); }
        else if (this.edit && e.keystroke === "cmd-i") { this.wrap("*", "*", "italic", cx); cx.stop_propagation(); }
      })
      .on_window_mouse_up("left", (_e, cx) => { if (this.drag) this.drop(cx); })
      .children(parts)
      .children(this.msg ? [h_flex().flex_none().h(34).px(12).gap(10).items_center().bg(t.raised).border_t(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().child(this.msg.text))
        .children(this.msg.undo ? [btn(t, "undo", "Undo", (_e, cx) => { const u = this.msg.undo; this.msg = null; u(); cx.notify(); }, { h: 24 })] : [])] : []);
  }
}
