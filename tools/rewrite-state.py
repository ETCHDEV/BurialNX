#!/usr/bin/env python3
"""
Rewrite src/main.ts to use the shared `S` state object from src/state.ts.

Strategy:
1. Drop lines whose every declared name (let/const) is a state field owned
   by state.ts. Parse declarations precisely (not via `[:=]` which also
   catches types and values).
2. For the remaining code, replace whole-word `varName` with `S.varName`
   ONLY when:
     - varName is a state field
     - NOT preceded by `.` or a word char (so we don't touch `obj.varName`)
     - NOT followed by `:` (so we don't touch `key:` in object literals or
       labels, and not `varName: T` in declaration syntax — but those lines
       are dropped in step 1)
     - NOT inside line / block comments
     - NOT inside string literals (single/double quotes)
     - INSIDE template literals, but ONLY within `\${...}` substitution
       expressions (NOT in the static text parts of the template)

Skips import lines entirely.

Idempotent: running twice == running once.
"""
import re
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / 'src' / 'main.ts'

STATE_VARS = """
ctx runtime menu previousButtons
browser selectedGame selectedMod sharedSaves languageEntries activeLanguageCode
waitForRelease phase pickerPurpose noticeReturnPhase saveLocation choiceFromMenu importRequested
message host mapPrefetch frames sampleStart fps lastFrame lastMemoryCheck lastFrameWall
fit saved settingsValid marqueeOffset gameStopped
exitArmed exitArmedAt exitNoticeArmed allowExit plusHoldStart exitBehavior
library libraryCursor libraryPage currentEntry
renameBuffer renameCursor renameSubmitted renamePreview
addGamePath addGameDefaultName addGameSubmitted addGamePreview
globalKeymap editingKeymap keymapTarget keymapCursor keymapValid keymapPicking keymapPickCursor
gameOptionsCursor gameOptionsScroll currentGameLanguages
directScreen directNext debugSettingsValid
forwarderTargetId forwarderForceMod isBakedForwarder
frameLoggedFirst
""".split()
assert len(STATE_VARS) == len(set(STATE_VARS))

STATE_SET = set(STATE_VARS)

def parse_declared_names(line: str):
    """Parse `let a = 1, b: T = 2, c;` → ['a', 'b', 'c']."""
    m = re.match(r'^\s*(?:let|const)\s+(.*?);?\s*$', line)
    if not m:
        return []
    body = m.group(1)
    parts = []
    depth = 0
    cur = ''
    for ch in body:
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    names = []
    for p in parts:
        im = re.match(r'\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]?', p)
        if im:
            names.append(im.group(1))
    return names

def replace_state_vars_in_text(text: str) -> str:
    """Replace whole-word state var names with `S.name`, but NOT when
    followed by `:` (object key) or preceded by `.` (member access)."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        # Skip string literals (single/double quotes).
        if ch in ('"', "'"):
            quote = ch
            out.append(ch)
            i += 1
            while i < n:
                c = text[i]
                out.append(c)
                if c == '\\' and i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
                if c == quote:
                    i += 1
                    break
                i += 1
            continue
        # Template literal: process ${...} parts with this function recursively.
        if ch == '`':
            out.append(ch)
            i += 1
            while i < n:
                c = text[i]
                if c == '\\' and i + 1 < n:
                    out.append(c)
                    out.append(text[i + 1])
                    i += 2
                    continue
                if c == '`':
                    out.append(c)
                    i += 1
                    break
                if c == '$' and i + 1 < n and text[i + 1] == '{':
                    # Find matching `}` at depth 0 (handle nested braces).
                    out.append(c)
                    out.append('{')
                    i += 2
                    depth = 1
                    expr_start = i
                    while i < n and depth > 0:
                        if text[i] == '{':
                            depth += 1
                        elif text[i] == '}':
                            depth -= 1
                            if depth == 0:
                                break
                        i += 1
                    expr = text[expr_start:i]
                    # Recursively replace state vars in the expression.
                    out.append(replace_state_vars_in_text(expr))
                    out.append('}')
                    i += 1  # consume the closing }
                    continue
                out.append(c)
                i += 1
            continue
        # Try to match a state var at this position.
        # Condition: not preceded by `.`, `_`, `$`, or a word char.
        prev_char = text[i - 1] if i > 0 else ''
        prev_ok = not (prev_char.isalnum() or prev_char in ('_', '$', '.'))
        if prev_ok:
            matched = False
            for v in STATE_VARS:
                if text[i:i + len(v)] == v:
                    end = i + len(v)
                    # Next char must NOT be `:` (object key), `_`, `$`, alnum.
                    next_ch = text[end] if end < n else ''
                    if next_ch == ':' or next_ch.isalnum() or next_ch in ('_', '$'):
                        continue
                    out.append('S.' + v)
                    i = end
                    matched = True
                    break
            if matched:
                continue
        out.append(ch)
        i += 1
    return ''.join(out)

def main():
    src = PATH.read_text(encoding='utf-8')
    lines = src.split('\n')
    out = []
    for line in lines:
        names = parse_declared_names(line)
        if names and all(n in STATE_SET for n in names):
            continue
        out.append(line)
    text = '\n'.join(out)

    # Now replace in non-comment, non-import lines.
    in_block_comment = False
    new_lines = []
    for line in text.split('\n'):
        stripped = line.lstrip()
        if stripped.startswith('import '):
            new_lines.append(line)
            continue
        if in_block_comment:
            new_lines.append(line)
            if '*/' in line:
                in_block_comment = False
            continue
        if stripped.startswith('/*'):
            new_lines.append(line)
            if '*/' not in line:
                in_block_comment = True
            continue
        if stripped.startswith('//') or stripped.startswith('*'):
            new_lines.append(line)
            continue
        # Strip leading comment chars and trailing line comment so we
        # don't touch state vars mentioned in inline comments. But preserve
        # the comment text in the output.
        # Find the start of a `//` line comment (outside strings/templ).
        # Simpler: just run replace on the whole line. Inside `//` comments
        # state vars would be replaced too, but comments don't affect
        # behavior. Acceptable trade-off for this one-time script.
        new_line = replace_state_vars_in_text(line)
        new_lines.append(new_line)

    result = '\n'.join(new_lines)
    PATH.write_text(result, encoding='utf-8')
    print(f'Rewrote {PATH}: {len(lines)} → {len(new_lines)} lines')

if __name__ == '__main__':
    main()
