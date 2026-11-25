# Feature overview

**Comparing files**
- Side-by-side view with synchronised scrolling. Deleted, inserted and modified lines are colour-coded, and the changed *words* in a modified line are highlighted (red for removed, green for added).
- A **status line under each pane** shows the file's encoding (ASCII, UTF-8, UTF-8 with BOM, UTF-16 or Latin-1), line endings (LF, CRLF, CR or mixed), line count, a missing final newline, and size. Whatever differs between the two files is highlighted, and files whose text is identical but whose encoding or line endings aren't say so ("Identical text; line endings differ"). As in a text editor, a file that ends with a newline shows an empty last line, so a final newline on one side only appears as one extra line you can merge like any other.
- A **line-details strip** at the bottom shows the current line pair in full, with visible whitespace (`·` spaces, `→` tabs, `¶` line ends), so long lines and spacing changes are easy to inspect.
- A **centre gutter** links each change on the left to its counterpart on the right, and an **overview map** on the right shows every change in the file at a glance. Click it to jump.
- **Whitespace and case options:** compare everything, or ignore leading/trailing whitespace, whitespace changes, all whitespace, or letter case.
- **Manual alignment:** right-click a line on each side to force them onto the same row.
- **Prettify** minified files: JSON, JavaScript, TypeScript, CSS, SCSS, Less, XML, SVG and HTML are reformatted one statement, rule or element per line on both sides, so a bundle that's one enormous line becomes a readable diff. It's a read-only view (turn it off to edit, merge or save), offered automatically when a file looks minified, and runs in the background with a Cancel button.
- Handles large files smoothly (tested up to 75MB and a million lines, and minified files with half-million-character lines); diffing runs off the UI thread.

**Editing and merging**
- Both panes are editors, with undo/redo, selection, clipboard and IME support. The comparison updates as you type.
- **▶ / ◀ merge arrows** copy a change from one side to the other.
- Save either side at any time, in its original encoding and line endings. Delta notices when a file changes on disk and offers to reload it.

**Comparing folders**
- Two folder trees side by side, with each file marked same, different, left only or right only.
- Compare by contents (exact), by size and modified date (fast), or by date alone (fastest). Large folders show progress and can be cancelled.
- **Stays current:** when files change in either folder (saved in an editor, a `git checkout`, a build), just those entries are compared again and the list updates in place, keeping what's expanded, selected and scrolled to. It works while you're looking at a file from the comparison too. Turn it off with **Update automatically** in the Compare by menu.
- Copy files or whole folders across, binary files included. Replacing a folder makes it match the other side exactly; anything only on the side being replaced is deleted, and the confirmation names it first.
- Copies are quick, and the list shows each one straight away (only what was copied is compared again): many files are copied at once (and cloned instantly on drives that support it, like APFS on macOS), a long copy shows its progress and can be cancelled, and nothing at the destination changes until the copy is complete, so cancelling, an error or a full disk leave it as it was. Double-click a file to open the pair in the text comparison; "← Folders" brings you straight back.

**Getting around**
- A start screen with your **20 most recent comparisons**. Paths on external drives are badged, and comparisons whose drive isn't connected (or whose files have gone) are flagged.
- Light and dark themes, a movable divider between the panes, full file paths in the pane headers, and keyboard shortcuts for everything common.

