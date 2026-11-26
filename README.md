# herdr-mod-note-list

Notes for [Herdr](https://herdr.dev), in two forms that share one data file:

- **Herdr app mod** (`herdr-app/mods/notes`): a Notes panel beside your work area, opened from a Notes button at the top right of the tab bar.
- **Herdr terminal plugin** (`herdr-plugin.toml`, `src/`): the same notes as a terminal pane, for the Herdr TUI.

Features: notes list with search, status and tag filters; colors, custom tags, due dates, todo status (none, todo, done); pinned notes always stay on top; drag to reorder; click a note to preview it, press Edit or double-click to edit; tick checklist items in the preview; export to JSON or Markdown and import it back.

## Where the data lives

`~/.herdr-notes/notes.json` on the machine that runs Herdr (set `HERDR_NOTES_DIR` to move it for the terminal plugin).
Panels and panes run on that machine, so spaces on remote machines use the same notes and nothing is installed there.
The app mod and the terminal plugin can run at the same time: each save merges with what is on disk, the newest edit per note wins and deletes win.

## Install: Herdr app

```sh
node scripts/install-app.mjs      # copies herdr-app/mods/notes to ~/.config/herdr-app/mods/notes
herdr-app check ~/.config/herdr-app/mods/notes
```

Then add the panel to your layout (edit the layout file you use, in `~/.config/herdr-app/layouts/`; clone a shipped layout first). Put this node in the row that holds your work area, next to the Files/Changes `panel`, outside any stack:

```json
{ "id": "notes-panel", "type": "column", "size": { "px": 440 }, "min": 340, "max": 900, "hidden": true,
  "children": [{ "id": "notes", "type": "block", "content": { "mod": "notes" } }] }
```

Open it with any of:

- a button that runs `layout.toggle {id: "notes-panel"}` (the tab bar mod can draw one; see below),
- a key in `keys.json`: `"alt-n": "layout.toggle:notes-panel"`,
- the command palette: Toggle Notes, New note, Export notes, Import notes.

The Notes button in the tab bar is code in the tab bar mod. In `mods/tabs-graph/main.js` it is this block, placed before the window buttons:

```js
.when(Boolean(find(root, "notes-panel")), el => el.child(h_flex().id("notes-open").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
  .text_size(12).bg(find(root, "notes-panel")?.hidden ? t.chrome : t.selected).text_color(find(root, "notes-panel")?.hidden ? t.muted : t.foreground)
  .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
  .on_click(() => run("layout.toggle", { id: "notes-panel" })).child(svg("mods/notes/icon.svg").size(14)).child("Notes")))
```

Herdr's own tab bar mods are replaced on every start, so clone the layout and the tab bar mod first (`layout.clone`, `mod.clone`) and add the block to your clone.

In the panel: Esc goes back (edit, then page, then list). `ctrl-b` and `ctrl-i` format in the editor. Drag a row by its grip to reorder (not while a filter or search is active). `herdr-app do notes.new` (or `notes.export`, `notes.import`, `notes.open`, `notes.back`) drives the panel from the shell.

## Install: Herdr terminal plugin

Needs Node 20 or newer on the Herdr host.

```sh
herdr plugin link /path/to/herdr-mod-note-list      # or: herdr plugin install owner/herdr-mod-note-list
```

Bind a key in `config.toml` (`prefix+m` is free in the default keymap), then `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "mod.notes.open"
description = "open notes"
```

Press `?` inside the pane for every key. Editing: the first line is the title, `esc` saves and returns to the preview.
Herdr documents no plugin toolbar button for the terminal version, so a key binding is its entry point.

## Develop

```sh
npm test                           # no dependencies; also checks core.js matches src/core.mjs
node scripts/install-app.mjs --sync-only   # refresh herdr-app/mods/notes/core.js from src/core.mjs
```

`src/core.mjs` holds the logic both versions share. The app runs mods in QuickJS and cannot import from `src/`, so the install script copies it to the mod as `core.js`.

Windows is native and tested against Herdr 0.9.5 and Herdr app 0.1.16. Linux and macOS are untested.

## Share on herdr.dev/mods

The Herdr app mod is the folder `herdr-app/` (`mods/notes/`, `keys.json`, `RECIPE.md`, `preview.png`). herdr.dev lists public GitHub repos that carry the topic `herdr-mod` within the hour. To list a new version, push to the default branch. Keep `herdr-app/mods/notes/core.js` in step with `src/core.mjs` (`npm test` checks it).
