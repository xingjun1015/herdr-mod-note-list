// Pure rendering: every screen returns { lines, cursor } for a given width and height.
import { COLORS, visible } from "./store.mjs";

const E = "\x1b[";
export const S = { r: E + "0m", b: E + "1m", d: E + "2m", i: E + "3m", u: E + "4m", st: E + "9m" };
const rgb = (r, g, b) => `${E}38;2;${r};${g};${b}m`;
export const COL = {
  red: rgb(224, 115, 111), amber: rgb(227, 178, 92), green: rgb(124, 196, 164), blue: rgb(111, 168, 224),
  violet: rgb(169, 139, 224), pink: rgb(224, 139, 181), gray: rgb(138, 145, 156),
};
const ACC = COL.green;
const DIM = COL.gray;

// ---- text width helpers (ANSI-aware, CJK/emoji = 2 cells) ----
export function cw(cp) {
  if (cp < 32) return 0;
  if (cp < 0x300) return 1;
  if (cp <= 0x36f) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const SGR = /\x1b\[[0-9;]*m/g;
export const sw = (s) => { let w = 0; for (const ch of s.replace(SGR, "")) w += cw(ch.codePointAt(0)); return w; };
export const pad = (s, w) => s + " ".repeat(Math.max(0, w - sw(s)));

export function clip(s, w) {
  if (w <= 0) return "";
  if (sw(s) <= w) return s;
  let out = "", cur = 0, m;
  const re = /\x1b\[[0-9;]*m|[\s\S]/gu;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t.length > 1) { out += t; continue; }
    const c = cw(t.codePointAt(0));
    if (cur + c > w - 1) break;
    out += t; cur += c;
  }
  return out + "…" + S.r;
}

const track = (open, str) => { for (const c of str.match(SGR) || []) open = c === S.r ? "" : open + c; return open; };

export function wrapAnsi(s, w) {
  w = Math.max(4, w);
  const lines = [];
  let line = "", cur = 0, open = "";
  const push = () => { lines.push(line + (open ? S.r : "")); line = open; cur = 0; };
  for (const word of s.split(" ")) {
    const ww = sw(word), sp = cur > 0 ? 1 : 0;
    if (cur + sp + ww <= w) { line += (sp ? " " : "") + word; cur += sp + ww; open = track(open, word); continue; }
    if (cur > 0) push();
    if (ww <= w) { line += word; cur = ww; open = track(open, word); continue; }
    const re = /\x1b\[[0-9;]*m|[\s\S]/gu; let m;
    while ((m = re.exec(word))) {
      const t = m[0];
      if (t.length > 1) { line += t; open = track(open, t); continue; }
      const c = cw(t.codePointAt(0));
      if (cur + c > w) push();
      line += t; cur += c;
    }
  }
  lines.push(line + (open ? S.r : ""));
  return lines;
}

export const ago = (t, now = Date.now()) => {
  const m = Math.max(1, Math.round((now - t) / 60000));
  return m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d";
};

// ---- markdown ----
export function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => COL.amber + c + S.r)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => S.b + c + S.r)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, p, c) => p + S.i + c + S.r)
    .replace(/\[\[([^\]]+)\]\]/g, (_, c) => COL.blue + S.u + c + S.r);
}

export function renderMd(body, w) {
  const out = [];
  let fence = false;
  body.split("\n").forEach((l, i) => {
    if (/^```/.test(l)) { fence = !fence; out.push({ t: DIM + "  ----" + S.r, src: i }); return; }
    if (fence) { out.push({ t: COL.amber + "  " + clip(l, w - 2) + S.r, src: i }); return; }
    let m, first = "", cont = "", txt = l, chk = false;
    if ((m = l.match(/^(\s*)- \[( |x)\] (.*)$/))) {
      const x = m[2] === "x";
      first = m[1] + (x ? COL.green + "[x]" : DIM + "[ ]") + S.r + " ";
      cont = m[1] + "    "; chk = true;
      txt = x ? S.d + S.st + inline(m[3]) + S.r : inline(m[3]);
    } else if ((m = l.match(/^(\s*)- (.*)$/))) {
      first = m[1] + "• "; cont = m[1] + "  "; txt = inline(m[2]);
    } else if ((m = l.match(/^(#{1,3}) (.*)$/))) {
      const c = [ACC, COL.blue, COL.violet][m[1].length - 1];
      txt = S.b + c + m[2] + S.r;
    } else if ((m = l.match(/^> ?(.*)$/))) {
      first = cont = DIM + "│ " + S.r; txt = S.i + inline(m[1]) + S.r;
    } else if (!l.trim()) { out.push({ t: "", src: i }); return; }
    else txt = inline(l);
    wrapAnsi(txt, w - sw(first)).forEach((ln, k) => out.push({ t: (k ? cont : first) + ln, src: i, chk }));
  });
  return out;
}

// ---- screens ----
const rule = (w) => DIM + "─".repeat(w) + S.r;
const hint = (pairs, w) => clip(pairs.map(([k, v]) => S.b + k + S.r + DIM + " " + v + S.r).join("  "), w);
const stripe = (n) => COL[n.color] + "▌" + S.r;

function footer(st, w, hints) {
  const lines = [];
  if (st.msg) lines.push(clip(COL.amber + st.msg + S.r, w)); else lines.push("");
  let cursor = null;
  if (st.prompt) {
    const p = st.prompt;
    if (p.keys) lines.push(clip(ACC + p.label + S.r, w));
    else { const lab = p.label + " "; lines.push(clip(ACC + lab + S.r + p.value, w)); cursor = { col: sw(lab) + sw(p.value) + 1 }; }
  } else lines.push(hint(hints, w));
  return { lines, cursor };
}

export const HINTS_LIST = [["j/k", "move"], ["enter", "open"], ["n", "new"], ["/", "search"], ["t", "todo"], ["c", "color"], ["p", "pin"], ["#", "tag"], ["d", "delete"], ["J/K", "reorder"], ["f", "filter"], ["x", "export"], ["i", "import"], ["?", "help"], ["q", "quit"]];

export function listScreen(st, w, h) {
  const list = visible(st.notes, st);
  const filtered = st.q || st.filter !== "all" || st.tag;
  const todo = st.notes.filter((n) => n.status === "todo").length;
  const head = ` ${S.b}${ACC}Notes${S.r}` +
    (st.filter !== "all" ? `  ${COL.amber}[${st.filter}]${S.r}` : "") + (st.tag ? `  ${COL.blue}[#${st.tag}]${S.r}` : "") +
    (st.q ? `  ${COL.amber}[search: ${st.q}]${S.r}` : "");
  const right = `${list.length}/${st.notes.length} notes ${todo} todo `;
  const lines = [clip(head, w - sw(right)) , rule(w)];
  lines[0] = pad(lines[0], w - sw(right)) + DIM + right + S.r;

  const rows = [], hasPin = list.some((n) => n.pinned);
  list.forEach((n, i) => {
    if (hasPin && (i === 0 || list[i - 1].pinned !== n.pinned)) rows.push({ head: n.pinned ? "PINNED (always on top)" : "OTHER NOTES" });
    rows.push({ n, i });
  });
  const room = Math.max(1, h - 4);
  const selRow = Math.max(0, rows.findIndex((r) => r.i === st.sel));
  let top = Math.min(st.scroll || 0, Math.max(0, rows.length - room));
  if (selRow < top) top = selRow; else if (selRow >= top + room) top = selRow - room + 1;
  st.scroll = top;
  st.rowMap = {};
  if (!rows.length) lines.push("", DIM + (filtered ? "  No notes match. Press esc to clear the search and filters." : "  No notes yet. Press n to write one.") + S.r);
  rows.slice(top, top + room).forEach((r, k) => {
    if (r.head) { lines.push(DIM + S.b + " " + r.head + S.r); return; }
    const { n, i } = r, on = i === st.sel;
    const box = n.status === "done" ? COL.green + "[x]" + S.r : n.status === "todo" ? COL[n.color] + "[ ]" + S.r : "   ";
    const left = ` ${on ? ACC + "▸" + S.r : " "}${stripe(n)} ${box} `;
    const due = n.due && n.status !== "done" ? ` due ${n.due.slice(5)}` : "";
    const tags = n.tags.map((t) => "#" + t).join(" ");
    const rt = DIM + (tags ? tags + "  " : "") + due.trim() + (due ? "  " : "") + ago(n.upd) + S.r;
    const avail = w - sw(left) - sw(rt) - 2;
    const prev = n.body.replace(/```[\s\S]*?```/g, "").replace(/^#+\s*/gm, "").replace(/[`*>]|\[\[|\]\]/g, "").replace(/^- (\[[ x]\] )?/gm, "").replace(/\s+/g, " ").trim();
    const ttl = (n.title || "Untitled");
    const titleStyled = (on ? S.b + ACC : n.status === "done" ? S.d + S.st : S.b) + ttl + S.r;
    const mid = clip(titleStyled + DIM + "  " + prev + S.r, Math.max(4, avail));
    lines.push(left + pad(mid, Math.max(4, avail)) + "  " + rt);
    st.rowMap[lines.length] = n.id; // 1-based screen row
  });
  while (lines.length < h - 2) lines.push("");
  const f = footer(st, w, HINTS_LIST);
  lines.length = h - 2;
  lines.push(...f.lines);
  return { lines, cursor: f.cursor ? { row: h, col: f.cursor.col } : null };
}

export function readScreen(st, w, h) {
  const n = st.notes.find((x) => x.id === st.openId);
  const meta = [n.status !== "none" ? n.status : "", n.pinned ? "pinned" : "", n.due ? "due " + n.due : "", ...n.tags.map((t) => "#" + t), "edited " + ago(n.upd) + " ago"].filter(Boolean).join("  ");
  const lines = [clip(` ${stripe(n)} ${S.b}${n.title || "Untitled"}${S.r}`, w), clip("  " + DIM + meta + S.r, w), rule(w)];
  const md = renderMd(n.body, w - 3);
  st.mdLen = md.length;
  st.cur = Math.max(0, Math.min(st.cur || 0, md.length - 1));
  const room = Math.max(1, h - 5);
  let top = st.rtop || 0;
  if (st.cur < top) top = st.cur; else if (st.cur >= top + room) top = st.cur - room + 1;
  st.rtop = top;
  md.slice(top, top + room).forEach((r, k) => lines.push((top + k === st.cur ? ACC + (r.chk ? "▸" : "▏") + S.r : " ") + " " + r.t));
  if (!md.length) lines.push(DIM + "  Empty note. Press e to write." + S.r);
  while (lines.length < h - 2) lines.push("");
  const f = footer(st, w, [["e", "edit"], ["space", "tick box"], ["j/k", "scroll"], ["t", "todo"], ["c", "color"], ["p", "pin"], ["#", "tag"], ["D", "due"], ["d", "delete"], ["esc", "back"]]);
  lines.length = h - 2;
  lines.push(...f.lines);
  return { lines, cursor: f.cursor ? { row: h, col: f.cursor.col } : null, md };
}

// Split a code point array into visual chunks of at most w cells.
export function chunks(cps, w) {
  const out = []; let start = 0, cur = 0;
  for (let i = 0; i < cps.length; i++) {
    const c = cw(cps[i].codePointAt(0));
    if (cur + c > w) { out.push([start, i]); start = i; cur = 0; }
    cur += c;
  }
  out.push([start, cps.length]);
  return out;
}

export function editScreen(st, w, h) {
  const ed = st.edit, rows = [];
  let crow = 0, ccol = 0;
  ed.lines.forEach((l, li) => {
    const cps = Array.from(l);
    const ch = chunks(cps, w - 1);
    ch.forEach(([a, b], k) => {
      if (li === ed.r && ed.c >= a && (ed.c < b || k === ch.length - 1)) { crow = rows.length; ccol = sw(cps.slice(a, ed.c).join("")); }
      rows.push({ text: cps.slice(a, b).join(""), li });
    });
  });
  const room = Math.max(1, h - 4);
  let top = ed.top || 0;
  if (crow < top) top = crow; else if (crow >= top + room) top = crow - room + 1;
  ed.top = top;
  const n = st.notes.find((x) => x.id === st.openId);
  const lines = [` ${S.b}${COL.amber}EDITING${S.r}  ${DIM}first line is the title${S.r}`, rule(w)];
  rows.slice(top, top + room).forEach((r) => lines.push(" " + (r.li === 0 ? S.b + ACC + r.text + S.r : r.text)));
  while (lines.length < h - 2) lines.push("");
  const f = footer(st, w, [["esc", "save and preview"], ["ctrl+b", "bold"], ["ctrl+l", "checklist"], ["tab", "indent"], ["arrows", "move"]]);
  lines.length = h - 2;
  lines.push(...f.lines);
  return { lines, cursor: st.prompt && f.cursor ? { row: h, col: f.cursor.col } : { row: 3 + crow - top, col: ccol + 2 }, n };
}

export const HELP = [
  ["List", ""],
  ["j k / arrows", "move"], ["enter", "open preview"], ["e", "open in edit mode"], ["n", "new note"], ["/", "search (esc clears)"],
  ["f / F", "cycle status filter / tag filter"], ["t", "cycle todo: none, todo, done"], ["c", "cycle color"], ["p", "pin or unpin (pinned stay on top)"],
  ["#", "add or remove a tag"], ["D", "set due date"], ["d then y", "delete"], ["u", "undo last delete or import"],
  ["J / K", "move note down / up"], ["mouse", "click select, double-click open, drag to reorder, click [ ] to toggle todo"],
  ["x / i", "export / import"], ["q", "close"],
  ["Preview", ""],
  ["j k", "move line"], ["space", "tick or untick checkbox on the line"], ["e or double-click", "edit"], ["esc", "back"],
  ["Edit", ""],
  ["esc", "save and return to preview"], ["ctrl+b", "insert bold"], ["ctrl+l", "cycle checklist on the line"], ["tab", "indent"],
];

export function helpScreen(st, w, h) {
  const lines = [` ${S.b}${ACC}Keys${S.r}`, rule(w)];
  for (const [k, v] of HELP) lines.push(v ? "  " + S.b + pad(k, 18) + S.r + clip(DIM + v + S.r, w - 22) : " " + S.b + COL.blue + k + S.r);
  while (lines.length < h - 1) lines.push("");
  lines.length = h - 1;
  lines.push(DIM + " Press any key to go back" + S.r);
  return { lines, cursor: null };
}

export { COLORS };
