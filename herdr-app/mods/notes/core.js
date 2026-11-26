// Pure note logic, shared by the terminal plugin and the Herdr app mod.
// No imports: the app mod runs in QuickJS, so install copies this file to the mod as core.js.

export const COLORS = ["red", "amber", "green", "blue", "violet", "pink", "gray"];
export const STATUSES = ["none", "todo", "done"];

export const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export function norm(o = {}) {
  const ts = (v) => (typeof v === "number" ? v : v ? Date.parse(v) || Date.now() : Date.now());
  return {
    id: o.id || newId(),
    title: String(o.title ?? ""),
    body: String(o.body ?? ""),
    color: COLORS.includes(o.color) ? o.color : "gray",
    tags: Array.isArray(o.tags) ? [...new Set(o.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))] : [],
    status: STATUSES.includes(o.status) ? o.status : "none",
    pinned: !!o.pinned,
    due: /^\d{4}-\d{2}-\d{2}$/.test(o.due || "") ? o.due : "",
    upd: ts(o.upd ?? o.updated),
  };
}

// Parse the text of notes.json. Throws on invalid JSON.
export function parseFile(text) {
  if (!text || !text.trim()) return { notes: [], deleted: [] };
  const j = JSON.parse(text);
  return { notes: (j.notes || []).map(norm), deleted: j.deleted || [] };
}

export const fileText = ({ notes, deleted }) => JSON.stringify({ version: 1, notes, deleted: deleted.slice(-500) }, null, 2);

// Two sessions can have the file open. Per note, the newest edit wins; deletions win over edits.
export function merge(ours, disk) {
  const dead = new Set([...ours.deleted, ...disk.deleted]);
  const theirs = new Map(disk.notes.map((n) => [n.id, n]));
  const seen = new Set();
  const notes = [];
  for (const n of ours.notes) {
    if (dead.has(n.id)) continue;
    const d = theirs.get(n.id);
    notes.push(d && d.upd > n.upd ? d : n);
    seen.add(n.id);
  }
  for (const n of disk.notes) if (!seen.has(n.id) && !dead.has(n.id)) notes.push(n);
  return { notes, deleted: [...dead] };
}

export const pinFirst = (a) => a.filter((n) => n.pinned).concat(a.filter((n) => !n.pinned));

export function visible(notes, { q = "", filter = "all", tag = "" } = {}) {
  const s = q.trim().toLowerCase();
  return pinFirst(notes).filter((n) => {
    if (filter === "todo" && n.status !== "todo") return false;
    if (filter === "done" && n.status !== "done") return false;
    if (filter === "pinned" && !n.pinned) return false;
    if (tag && !n.tags.includes(tag)) return false;
    return !s || `${n.title}\n${n.body}\n${n.tags.join(" ")}`.toLowerCase().includes(s);
  });
}

// Move note `id` next to `targetId` in the master array (same pin group only).
export function place(notes, id, targetId, after) {
  const a = notes.find((n) => n.id === id), b = notes.find((n) => n.id === targetId);
  if (!a || !b || a === b || a.pinned !== b.pinned) return false;
  notes.splice(notes.indexOf(a), 1);
  notes.splice(notes.indexOf(b) + (after ? 1 : 0), 0, a);
  return true;
}

// ---- export / import ----
export const toJSON = (notes) =>
  JSON.stringify({ app: "herdr-notes", version: 1, exported: new Date().toISOString(),
    notes: notes.map((n) => ({ title: n.title, body: n.body, color: n.color, tags: n.tags, status: n.status, pinned: n.pinned, due: n.due, updated: new Date(n.upd).toISOString() })) }, null, 2);

const slug = (s) => (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "untitled";

export const toMarkdownFiles = (notes) =>
  notes.map((n, i) => ({
    name: `${String(i + 1).padStart(2, "0")}-${slug(n.title)}.md`,
    content: `---\ntitle: ${n.title}\ncolor: ${n.color}\ntags: [${n.tags.join(", ")}]\nstatus: ${n.status}\npinned: ${n.pinned}\ndue: ${n.due}\n---\n\n${n.body}\n`,
  }));

// One text file holding every Markdown note, each after a "=== file: name ===" line.
export const toMarkdownBundle = (notes) => toMarkdownFiles(notes).map((f) => `=== file: ${f.name} ===\n${f.content}`).join("\n");

export function fromMarkdown(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n+([\s\S]*)$/);
  const f = {};
  let body = text;
  if (m) {
    body = m[2].replace(/\n$/, "");
    for (const l of m[1].split(/\r?\n/)) { const k = l.indexOf(":"); if (k > 0) f[l.slice(0, k).trim()] = l.slice(k + 1).trim(); }
  }
  const h = body.match(/^#+ (.+)$/m);
  return norm({ title: f.title || (h ? h[1] : "Imported note"), body, color: f.color, status: f.status, due: f.due, pinned: f.pinned === "true",
    tags: f.tags ? f.tags.replace(/[\[\]]/g, "").split(",") : [] });
}

// Accepts a Herdr Notes JSON export (or a bare array), a Markdown note, or a Markdown bundle. Throws Error with a readable message.
export function parseImport(text, name = "") {
  const t = text.trim();
  if (!t) throw new Error("The file is empty.");
  if (name.endsWith(".json") || t[0] === "{" || t[0] === "[") {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error("Not valid JSON."); }
    const a = Array.isArray(j) ? j : j.notes;
    if (!Array.isArray(a)) throw new Error("This JSON has no notes list.");
    return a.map((o) => norm({ ...o, id: undefined }));
  }
  if (t.includes("=== file:")) return t.split(/^=== file: .*? ===\r?\n/m).filter((s) => s.trim()).map(fromMarkdown);
  return [fromMarkdown(t)];
}

export const isDup = (notes, n) => notes.some((x) => x.title === n.title && x.body === n.body);

export function welcome() {
  return [
    norm({ title: "Welcome to Notes", color: "green", tags: ["herdr"], pinned: true, status: "todo",
      body: "# Welcome\n\nNotes live on the machine running Herdr, so remote sessions see the same notes.\n\n- [ ] Write your first note\n- [ ] Pin a note to keep it on top\n- [x] Open Notes\n\nUse **bold**, `code`, and [[links]]." }),
  ];
}
