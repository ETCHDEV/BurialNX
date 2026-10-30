# `game-compat.ts`

The compatibility shim that adapts a stock RPG Maker MV game (specifically *The Coffin of Andy and Leyley*, "TCOAAL") to the nx.js Switch runtime: strips or rewrites the few desktop-only plugin payloads that cannot run on nx.js, normalizes `'use strict'` handling so indirect-evaluated game scripts behave like `<script>` tags, parses the game's `.cld` language packs (fonts, translated images, sysMenu/sysLabel tables) and injects the translation hooks into `Window_Base` / `Bitmap` / `Game_Message`, wires up font registration, system-term wrapping, touch forwarding, save/load resume-from-choice fixes, autosave-to-SD redirection, defensive bitmap/windowskin getters, and WebAudio panner shims. This module is the single largest concentration of "why this hack exists" rationale in the project.

## `prepareGameScript` (top-level JSDoc)

> /**
>  * Two desktop-only plugins cannot run on nx.js. Use MV audio instead of the
>  * streaming Worker, and omit only the appended Node payload from the region
>  * plugin. The region collision rules themselves must remain enabled.
>  *
>  * Additionally, the top-level `'use strict'` directive is stripped from every
>  * script. BurialNX evaluates game scripts via indirect eval `(0, eval)(...)`,
>  * which runs in the global scope. Under strict mode, indirect eval does NOT
>  * leak `var`/`function` declarations to the global object — so a plugin that
>  * declares `function Game_EnemyEvent() {}` under `'use strict'` would NOT
>  * expose `Game_EnemyEvent` as a global, and subsequent plugins referencing it
>  * would throw `ReferenceError: Game_EnemyEvent is not defined`. In a browser
>  * `<script>` tag, top-level declarations become global even under strict mode
>  * (a special case for script-tag evaluation). Stripping the directive makes
>  * indirect eval run in sloppy mode, matching that behavior. Only the top-level
>  * directive prologue is stripped; `'use strict'` inside function bodies (which
>  * affects those functions' semantics) is preserved.
>  */

## `prepareGameScript` (YEP_RegionRestrictions branch)

> // Keep the code before the single-line desktop bootstrap. Depending on
> // the game build it closes a method or initializes the RR namespace.
> // Reject unfamiliar layouts rather than deleting real plugin code.

## `prepareGameScript` (top-level 'use strict' strip call)

> // Strip the top-level 'use strict' directive so indirect eval runs in
> // sloppy mode and function/var declarations become global (like a
> // <script> tag). See the function-level comment above for the full
> // rationale. Only the directive prologue (before any real code) is
> // stripped; function-body 'use strict' directives are preserved.

## `stripTopLevelUseStrict` (JSDoc)

> /**
>  * Remove the top-level `'use strict'` / `"use strict"` directive prologue
>  * from a script source. The directive is only stripped when it appears as the
>  * first actual statement (after optional comments and whitespace). Directives
>  * inside function bodies are left intact because they affect those functions'
>  * runtime semantics (e.g. `this` binding, assignment to undeclared variables).
>  *
>  * Uses a single-pass line scan (O(n)) rather than a regex to avoid
>  * catastrophic backtracking on large files like rpg_core.js (240+ KiB).
>  */

## `stripTopLevelUseStrict` (internal step rationale)

> // still inside a multi-line block comment   (inline trailing on `else continue;`)

> // Strip any remaining inline block comments on this line (non-nested).

> // Strip line comments.

> // whitespace or comment-only line   (inline trailing on `if (!trimmed) continue;`)

> // First real code line — check if it's a 'use strict' directive.

> // First real code is something else — no top-level 'use strict' to strip.

## `LanguagePack` (interface JSDoc)

> /**
>  * A fully-decoded language pack. The base `Language` type holds the translation
>  * tables used by translate(); this wrapper carries the extra metadata embedded
>  * in a `.cld` pack (font + translated images) so the loader can register them.
>  */

### `LanguagePack` property docs (preserved in source)

> /** Logical font-family name to use for this language (e.g. 'bitter-pro-regular'). */
> /** Font size in pixels to use for this language (e.g. 24 for Russian vs 28 English). */
> /** Base64-encoded font file (TTF/OTF/WOFF) embedded in the .cld, or null. */
> /** Map of hashed asset path → base64-encoded replacement image (PNG). */
> /** Human-readable language name (e.g. 'Русский'). */
> /** The asset path this pack was loaded from, for diagnostics. */

## `parseLanguagePack` (internal rationale)

> // Extract the tables translate() actually reads; keep the rest as raw metadata.

## `DEFAULT_LANGUAGE_PATH`

> /** The hashed asset path of the default (English) language data embedded in data/. */

## `languageTable`

> /**
>  * Load the default (English) language table. Kept for backward compatibility with
>  * tests and callers that only need the translation tables. Prefer loadLanguagePack().
>  */

## `loadLanguagePack`

> /**
>  * Load a language pack from a `.cld` file. Falls back to the default English data
>  * embedded in data/ when the requested pack cannot be read. Always returns a pack
>  * (never null) when the default exists; returns null only if neither the requested
>  * pack nor the default could be read.
>  */

## `LanguageScanFs`

> /** A minimal Switch filesystem surface for scanning language folders. */

## `LanguageEntry` (property docs)

> /** Asset path suitable for `assets.read()` — relative to the game www root. Only set when the pack lives inside www (no `..`). */
> /** Absolute sdmc path for direct Switch.readFile() — always set. Used when the pack lives one level above www (assetPath rejects `..`). */
> /** Short code derived from the filename, e.g. 'ru' for 'ru.cld'. */
> /** Human-readable name decoded from the pack's langName, or the code. */

## `scanLanguageFiles` (JSDoc)

> /**
>  * Scan the `languages/` folder (and one level above the www root as a fallback)
>  * for `.cld` language packs. Returns entries sorted by code. The www-relative
>  * path is preferred because RPG Maker MV games ship languages there; the parent
>  * folder is checked because some builds place `languages/` next to the exe.
>  */

## `scanLanguageFiles` (internal rationale)

> // The game root is the www folder. languages/ may be inside it, or one level up.

> // For in-www languages, path is a relative asset path the Reader accepts.
> // For parent-folder languages, path is null (assetPath rejects `..`); callers read via absPath.

> // Sort by code for deterministic ordering. 'ru' (Russian) is the primary
> // target language for this game; keep it first if present.

## `resolveLanguageName`

> /**
>  * Best-effort lookup of a human-readable name for a language pack by peeking at
>  * its `langName` field. Used so the scan results can show 'Русский' instead of 'ru'.
>  * Falls back to the code if the pack can't be read or parsed.
>  */

## `decodeBase64` (internal rationale)

> // Use atob when available (Switch runtime + tests); fall back to manual decode.

> // Manual decode path (no atob).

## `rollbackInterpreterForMessageWait` (JSDoc — save-mid-choice bug rationale)

> /**
>  * Roll back a Game_Interpreter that is waiting on a message (`_waitMode ==
>  *  'message'`) so the save captures it at the ShowText (101) / ShowChoices
>  *  (102) command instead of PAST the choice branches. On load (and on
>  *  resume after save), the interpreter re-runs 101/102 → setupChoices
>  *  re-populates $gameMessage + re-establishes the choice callback → the
>  *  choice re-displays (instead of being skipped because $gameMessage isn't
>  *  saved). The 101/401/102 commands are display-only, so re-running them
>  *  has no side effects.
>  *
>  *  Scans the interpreter's `_list` backwards from `_index - 1` for a command
>  *  with code 101 (ShowText, preferred — re-runs text + choices) or 102
>  *  (ShowChoices, fallback — choices only), stopping at a lower indent
>  *  (outside the message block). Sets `_index` to that command, clears
>  *  `_waitMode`, and clears `$gameMessage` so the re-run re-populates it
>  *  fresh.
>  */

## `rollbackInterpreterForMessageWait` (internal rationale)

> // Stop at a lower indent (we've left the message block).

> // ShowText — prefer (re-runs text + choices)   (inline trailing on the `if (cmd.code === 101)` branch)

> // ShowChoices — fallback   (inline trailing on the `if (cmd.code === 102 ...` branch)

> // No 101/102 found — can't roll back safely.

> // Clear $gameMessage so the re-run re-populates it fresh (avoids
> // stale text/choices state lingering from before the save).

## `registerLanguageFont` (JSDoc)

> /**
>  * Register the font embedded in a language pack (if any) and override RPG Maker
>  * MV's font selection so the game actually uses it. The .cld's fontFile is a
>  * base64-encoded TTF/OTF/WOFF; we decode it, create a FontFace, and add it to the
>  * runtime font set. We also override Window_Base.standardFontFace and
>  * standardFontSize (and Yanfly's YEP_CoreEngine override of the same) so every
>  * window and bitmap draws with this language's font instead of GameFont.
>  *
>  * Registers ALL 4 variants (normal, bold, italic, bold-italic) — same as
>  * registerFonts — so the game can render bold/italic text in the language font.
>  * Without all 4 variants, bold/italic text falls back to GameFont which has
>  * no Cyrillic glyphs → empty/blank dialogue lines.
>  */

## `registerLanguageFont` (internal rationale)

> // Register ALL 4 variants (normal, bold, italic, bold-italic)
> // — same pattern as registerFonts. Without bold/italic variants,
> // the game falls back to GameFont for bold/italic text, which
> // has no Cyrillic glyphs → empty lines for Russian dialogue.

> // Yanfly's YEP_CoreEngine replaces standardFontFace to read Yanfly.Param.DefaultFont.
> // Override that parameter so the YEP path also picks up the language font.

> // YEP_MessageCore has its OWN font system for dialogue windows:
> // it overrides standardFontFace for Window_Message, Window_ChoiceList,
> // and Window_NameBox to return $gameSystem.getMessageFontName() which
> // reads from Yanfly.Param.MSGFontName (= "GameFont"). Without overriding
> // these, dialogue text uses GameFont (no Cyrillic glyphs) → empty lines.
> // Fix: override the YEP message font parameters AND the message window
> // prototypes' standardFontFace directly.

> // Graphics.fontFace is the Bitmap default; set it so raw Bitmap draws match.

> // Bitmap's constructor default is 'GameFont'; update the prototype property too.

> // Override message font size too (YEP_MessageCore uses MSGFontSize).

## `withLanguageImages` (JSDoc)

> /**
>  * Wrap a Reader so that paths listed in the language pack's `imgFiles` return the
>  * base64-decoded replacement image instead of reading from disk. This applies
>  * translated parallaxes, title art, and any other localized images. Paths not in
>  * the pack fall through to the base reader unchanged.
>  */

## `withLanguageImages` (internal rationale)

> // Pre-decode images lazily (the Russian pack has 44 images; decoding all
> // upfront would spike memory). Cache the decoded buffer per path.

> // imgFiles keys may omit extensions or use a hashed path that the
> // request normalizes; try a few close matches.

## Module constants `TRANSLATE_NAMES` / `TRANSLATE_RE`

> // Hoisted constants for translate() — avoid per-call allocation of the names
> // object and the regex. The fast path (no '(' in input) skips the regex
> // entirely for ~95% of drawText calls, which is the common case for games
> // without language packs or for text that doesn't use escape sequences.

## `translate` (internal rationale — fast path)

> // Fast path: if there's no '(' character, the escape-sequence regex can't
> // match anything — return the input unchanged without allocating regex
> // state or a callback closure.

## `registerFonts`

> /** Fonts are read from the game's own stylesheet and remain outside the NRO. */

## `wrapSystemTerms` (JSDoc)

> /**
>  * Wrap the game's plain-English system text (terms, plugin title strings) in
>  * translate() escape sequences so the loaded language pack can convert them.
>  *
>  * The game's $dataSystem.terms (commands, basic, params, messages) and plugin
>  * constants (e.g. Galv.CRED.titleText = "Credits") hold raw English strings.
>  * The .cld's sysMenus/sysLabel tables map those English keys to translations,
>  * but translate() only fires on `(sysMenus)[key]` / `(sysLabel)[key]` escape
>  * sequences. On PC the game's obfuscated language loader wraps these strings;
>  * BurialNX replicates that by wrapping every term that has a matching table key.
>  *
>  * Only strings whose value EXACTLY matches a table key are wrapped, so terms
>  * without a translation are left untouched (no ugly "(sysMenus)[...]" shown).
>  *
>  * This must run AFTER $dataSystem is loaded (DataManager.onLoad) and AFTER any
>  * plugin that sets title-text constants (i.e. after all scripts are evaluated).
>  */

## `wrapSystemTerms` (internal rationale)

> // The .cld's sysMenus keys don't always match the game's standard RPG Maker
> // MV text. For example, the game's option label is "Always Dash" but the .cld
> // uses "Run Always". This map bridges the gap: when a game string has no
> // direct sysMenus/sysLabel key, check if a known alias exists.

> // Try alias mapping: "Always Dash" → check sysMenus["Run Always"]

> // 1. $dataSystem.terms (commands, basic, params, messages) — the main
> //    source of menu/window text in RPG Maker MV.

> // 2. $dataSystem.gameTitle — the .cld's sysLabel['Game'] holds the translated
> //    game title (e.g. "Гроб для Энди и Лейли"). The English gameTitle is NOT the
> //    key "Game"; the game's own language loader maps gameTitle → sysLabel['Game'].
> //    Replicate that by wrapping the title in (sysLabel)[Game] unconditionally.

> // 3. The save/load prompts. The game's terms.messages.saveMessage is
> //    "Save to which file?" but the .cld's sysLabel['Save'] = "Какой файл
> //    перезаписать?" — the key 'Save' maps to the save prompt, not the raw
> //    message text. Map them explicitly (same for Load).

> // 4. Plugin title-text constants. Galv.CRED.titleText = "Credits" → sysMenus['Credits'].

## `installGameCompatibility` (declaration summary)

> /** Install after plugins load, before window.onload starts the game. */

## `installGameCompatibility` — credits scene guard

> // The bundled credits scene is currently unreliable on nx.js. Keep its
> // title entry visible but disabled and make event-script calls harmless.
> // Remove this guard only after the credits scene is tested on hardware.

## `installGameCompatibility` — touch forwarding

> // Forward screen touch events to document for RPG Maker MV's TouchInput.
> // nx.js dispatches 'touchstart'/'touchmove'/'touchend' on the `screen`
> // global. RPG Maker MV's TouchInput listens on `document`. Without
> // forwarding, touch/tap interactions in the game don't work.
> // The listeners are installed ONCE per process: each new launch
> // replaces globalThis.document with a fresh one, so the handler
> // resolves the current document at event time instead of closing over
> // the document of the first launch (which would send the second
> // game's touches to a dead document, and stack a listener set per
> // launch on the shared screen object).

> // RPG Maker MV's TouchInput uses touch.pageX/pageY.
> // nx.js touch events have clientX/clientY but not pageX/pageY.
> // Add them as aliases so the game can read them.

## `installGameCompatibility` — bitmap image-pool cleanup

> // MV normally keeps a pool of Image objects. Native images can retain their
> // pixel buffers and bound listeners, so release those references on cleanup.

## `installGameCompatibility` — WindowLayer temp canvas

> // WindowLayer explicitly clears its temporary canvas each frame. Avoid
> // repeatedly allocating a same-sized native surface for that one canvas.

## `installGameCompatibility` — autosave isolation

> // The game's skipped desktop helper provides autoSave(). Keep its recovery
> // snapshot separate from ordinary slots so it cannot overwrite the player.

## `installGameCompatibility` — wrapSystemTerms call

> // Wrap the game's system text (terms, gameTitle, plugin constants) in
> // translate() escape sequences so the loaded language pack can convert
> // the title-menu commands, item/skill names, save/load prompts, etc.
> // This runs once now (for plugin constants like Galv.CRED.titleText that
> // were set during script evaluation) and again when $dataSystem loads.
> // Wrapped in try/catch so a translation failure never crashes the game.

## `installGameCompatibility` — onLoad $dataSystem re-wrap

> // $dataSystem carries the terms (commands/basic/params/messages)
> // and gameTitle. Wrap them now so the title-menu and every window
> // that reads TextManager sees the escape sequences translate() hooks.

## `installGameCompatibility` — setupNewGame start position

> // This game's intro card uses this known starting position and its
> // first transfer makes the player visible again.

## `installGameCompatibility` — autosave to SD card (not localStorage)

> // Write the recovery snapshot to the SD card, NOT localStorage.
> // nx.js implements localStorage on top of account save data, so the
> // first `localStorage.setItem(...)` lazily launches the profile-picker
> // applet (because startupUserAccount=0 means no user is preselected).
> // That would interrupt gameplay with a "select a user" dialog every
> // time autosave fires. Redirecting to a regular file on the SD card
> // keeps the recovery-snapshot feature working without ever touching
> // localStorage — consistent with how installSdSaves() writes the
> // game's own .rpgsave slots to the SD card.

> // Do not overwrite recovery snapshots made by the previous loader.

## `installGameCompatibility` — save-mid-choice bug fix (section divider + rationale)

> // === Fix: save mid-choice → load should resume ON the choice, not skip past it. ===
> //
> // RPG Maker MV's `DataManager.makeSaveContents` deliberately EXCLUDES
> // `$gameMessage` from the save data (see the comment in rpg_managers.js:
> // "A save data does not contain $gameTemp, $gameMessage, and $gameTroop").
> // The interpreter's `_waitMode='message'` IS saved (it's on the
> // Game_Interpreter, serialized via $gameMap). So on load:
> //   - the interpreter is at the ShowChoices command (index past 101/102,
> //     pointing at the first choice branch 402), `_waitMode='message'`;
> //   - `$gameMessage` is fresh/empty (not saved);
> //   - `updateWaitMode('message')` → `$gameMessage.isBusy()` = false →
> //     `_waitMode=''` → the interpreter ADVANCES past the choice branches;
> //   - the branches (402) check `_branch[indent]` which is unset (the
> //     choice callback was never called) → skipBranch → the game skips
> //     the entire choice → the user is "thrown further" than the choice.
> //
> // FIX: wrap `DataManager.makeSaveContents` to, BEFORE serializing, roll
> // the waiting interpreter's `_index` BACK to the ShowText (101) or
> // ShowChoices (102) command that set up the message, and clear
> // `_waitMode`. The save then captures the interpreter at the 101/102
> // command (not waiting). On load (and on resume after save), the
> // interpreter RE-RUNS 101/102 → setupChoices re-populates $gameMessage
> // + re-establishes the choice callback → setWaitMode('message') → the
> // choice re-displays. The 101/401/102 commands are display-only (no
> // side effects), so re-running them is safe.

> // Roll back any interpreter waiting on a message so the choice
> // re-displays on load instead of being skipped.

## `installGameCompatibility` — defensive bitmap/windowskin getters (section divider + rationale)

> // === Defensive: prevent the "Cannot read properties of undefined
> // (reading 'bitmap' / 'getPixel')" crashes when resuming from
> // Scene_Save/Scene_Load during a dialogue choice. ===
> //
> // Root cause (from studying the game's rpg_core.js / rpg_windows.js):
> // `SceneManager.pop` → `goto(prevClass)` → `new Scene_Map()` — a FRESH
> // scene is created (scenes don't "resume"). Scene_Map.create →
> // createMessageWindow → new Window_Message + sub-windows. Scene_Map.start
> // → Window_Message.update → (canStart || startInput) → startMessage /
> // _choiceWindow.start() → refresh → createContents → `this.contents =
> // new Bitmap(...)` → setter `this._windowContentsSprite.bitmap = value`
> // AND drawItem → resetTextColor → textColor → `this.windowskin.getPixel`.
> // If `_windowContentsSprite` or `_windowskin` is undefined at that
> // moment → crash.
> //
> // IMPORTANT: the earlier fix only suppressed `canStart`, but
> // Window_Message.update falls through to `startInput()` when canStart
> // is false — and startInput → `$gameMessage.isChoice()` →
> // `_choiceWindow.start()` STILL runs the choice re-draw during the
> // suppress window. So the suppress must cover the WHOLE message
> // processing loop (update), not just canStart.
> //
> // Two-layer fix:
> //  (1) Suppress `Window_Message.update`'s message-processing loop for
> //      a few frames after a save/load pop (flag set by
> //      installSaveLoadPopHook). Only the parent Window_Base.update
> //      (window animation / openness) runs; startMessage AND startInput
> //      (→ choice window start → refresh → drawItem → getPixel) are
> //      deferred until the fresh scene's windows fully settle.
> //  (2) Make Window.prototype.contents AND windowskin getters robust
> //      against a missing _windowContentsSprite / _windowskin: lazily
> //      create a dummy sprite+bitmap instead of crashing. Belt-and-braces
> //      that catches any remaining undefined-sprite/bitmap access.

## `installGameCompatibility` — Window_Message.update suppress

> // Skip the message/choice processing loop (the `while`
> // in Window_Message.update that calls canStart /
> // startMessage / startInput → _choiceWindow.start).
> // Only run the parent Window_Base.update so the
> // window still animates (openness etc.). This
> // defers BOTH startMessage AND the choice-window
> // start until the fresh scene's windows settle.

## `installGameCompatibility` — `contents` defensive getter

> // Defensive: `contents` getter/setter — lazily create a dummy
> // _windowContentsSprite + 1x1 bitmap if undefined (prevents the
> // "reading 'bitmap'" crash).

## `installGameCompatibility` — `windowskin` defensive getter

> // Defensive: `windowskin` getter — lazily create a dummy _windowskin
> // bitmap if undefined (prevents the "reading 'getPixel'" crash in
> // Window_Base.textColor → this.windowskin.getPixel).

> // Lazily create a dummy 1x1 bitmap AND try to load the real
> // windowskin so textColor/getPixel don't crash on undefined.
> // Bitmap.getPixel on a 1x1 returns a transparent-ish color
> // (no crash) — enough to survive the resume frame.

## `installGameCompatibility` — Window_Options boolean status text

> // RPG Maker MV's Window_Options.booleanStatusText returns 'ON'/'OFF'
> // (hardcoded uppercase). The .cld's sysMenus has 'On'/'Off' keys → wrap
> // them in escape sequences so translate() converts them (e.g. 'ON' →
> // '(sysMenus)[On]' → 'Вкл.'). The translate() hook on drawText then
> // converts them when the option status is drawn.

## `installGameCompatibility` — WebAudio createPanner shim

> // RPG Maker MV's WebAudio._createNodes calls context.createPanner() for
> // every audio source. nx.js's AudioContext does NOT implement createPanner
> // (it throws "Method not implemented."). The context may be created DURING
> // SCRIPT LOADING (the WebAudio constructor calls WebAudio.initialize() →
> // _createContext() the first time `new WebAudio(url)` runs), which is
> // BEFORE installGameCompatibility runs. So patching _createContext alone
> // is too late. Instead, patch _createNodes (the instance method that
> // actually calls createPanner) to ensure createPanner is overridden on
> // the context right before it's used — regardless of when the context
> // was created.

> // Shared no-op closures (hoisted to avoid per-panner allocation).

> // Helper: create a working panner node replacement.

> // MV calls setPosition(x, y, z) with 3 args; StereoPanner only
> // takes pan (-1..1). Use x as pan, ignore y/z.

> // panningModel is a PannerNode property; StereoPanner doesn't
> // have it. Make it a no-op setter so MV's assignment doesn't throw.

> // Fallback: a GainNode that accepts setPosition() but
> // ignores it. Audio passes through without panning.

> // Install createPanner override on a context (once). The closure
> // captures `context` so it can be shared across all audio sources
> // that use that context — no per-source allocation.

> // Patch _createContext (for contexts created after this point).

> // ALSO patch the existing context if it was already created.

> // CRITICAL: Patch _createNodes (instance method) to ensure
> // createPanner is overridden on the context right before it's
> // called. This catches the case where the context was created
> // during script loading (before installGameCompatibility).
> // installPanner() is idempotent (checks __bnxPannerInstalled),
> // so calling it per-source is cheap — no closure allocation.

## `installGameCompatibility` — name box / message window layout

> // Anonymous center-screen interaction text has excess empty space in MV.
