# How the diff works

Delta's comparison engine (`src/engine/`) is written from scratch in TypeScript with no diff libraries. It's pure logic with no UI or Node dependencies, so it runs in a background worker and is fully unit-tested.

1. **Read and split.** Files are decoded (UTF-8, UTF-16 or Latin-1, detected from byte-order marks and content). Binary files are refused, since Delta compares text. Text is split into lines, remembering line endings so files can be saved back unchanged.
2. **Normalise.** Each line is turned into a comparison key according to the active options (whitespace mode, ignore case), and interned to an integer, so the core compares numbers, not strings.
3. **Prune.** Lines that appear on only one side can never match, so they're set aside before diffing. This keeps the result exact and makes heavily rewritten files almost free.
4. **Histogram diff, anchored on rare lines.** As in `git diff --histogram`, lines that occur exactly once on each side (a function's signature, a distinctive statement) are matched first, choosing the chain that keeps both files in order and sits in the longest runs of matching lines. The gaps between them are diffed the same way in turn. Common lines (`}`, blank lines, `try:`) never pull unrelated code into alignment, so moved or rewritten blocks read as whole blocks instead of being scattered across the file. It's slightly less minimal by design; on files up to 50,000 lines Delta also runs Myers and uses it if histogram's result is clearly larger.
5. **Myers' O(ND) algorithm** handles regions with no rare lines. It's Eugene Myers' classic difference algorithm in its **linear-space** form. It searches from both ends at once to find the "middle snake" of the shortest edit path, then recurses on each half, as GNU `diff` does. It finds a minimal set of changes, and its running time grows with the *number of differences*, not just file size, so similar files diff very quickly. A cost cap keeps pathological inputs fast.
6. **Tidy.** Inserted and deleted blocks that could equally sit a few lines up or down are slid to natural boundaries (ending on a blank line), so whole functions and paragraphs read as one change.
7. **Pair lines.** Within a changed region, lines are paired by similarity (character-bigram overlap), so an edited line sits next to its new version even if lines were added around it.
8. **Highlight words.** For each changed line on screen, a second, word-level diff runs on words and punctuation, with spacing compared separately. Highlights are merged into whole phrases, and lines that were rewritten rather than edited are highlighted in full. Very long lines (minified code) get one highlight between their common start and end instead, so they stay instant.

**Performance** (Apple M3 Pro):

| Input | Time |
|---|---|
| 1 million lines (75MB), an edit every 500 lines | ~1.6 s |
| 200,000 lines with ~2,300 scattered edits | ~150 ms |
| Two 100,000-line files with nothing in common | near-instant |
