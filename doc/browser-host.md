# `browser-host.ts`

`browser-host.ts` supplies the minimal browser-host shims RPG Maker MV needs to boot inside nx.js: a `document`/DOM tree with `canvas`, `script`, `audio`/`video` nodes; an `XMLHttpRequest` backed by the asset reader; a `fetch` bridge restricted to game resources and local blob/data URLs; an `Image` wrapper that defers load/error dispatch one turn and swallows empty `src` resets; plus screen-fit presentation. nx.js itself already supplies canvas, audio, images and timers — this module fills in only the missing `document` and local-resource APIs; it is not a general browser.

## `resourceFetch`
> Only game resources and locally generated blob/data URLs use this bridge.
> This is not a sandbox: game code still has the runtime's native APIs.

## `createBrowserHost`
> RPG Maker MV expects a few browser objects. nx.js already supplies canvas,
> audio, images and timers; this supplies only the missing document and local
> resource APIs. It is not a general browser.

## `createBrowserHost` — preserving the real native fetch
> Keep the REAL native fetch. createBrowserHost runs again when the
> user returns to the library and starts another game; at that point
> globalThis.fetch is our previous resourceFetch wrapper, and binding
> that would stack one wrapper per launch. The marker on the wrapper
> preserves the original fetch across launches.

## `CanvasNode.useScreen` — direct screen drawing
> Only the primary game canvas may draw directly to the physical screen.

## `CanvasNode.getContext` — trailing inline (return null for non-2d)
> Let PIXI choose its Canvas renderer.

## `CanvasNode.getContext` — RepeatedPattern for missing patterns
> PIXI's patterns are unavailable on some nx.js versions. Batch tiny
> textures into bounded tiles instead of drawing once per pixel.

## `CanvasNode.getContext` — method wrapper caching
> Canvas methods are accessed many times per frame. Reuse wrappers
> instead of allocating a new bound function for every draw call.

## `document.fonts.ready` — FontFaceSet.ready quirk
> FontFaceSet.ready resolves to the set itself, not to undefined.

## `XHR.send` — async game-callback error reporting
> Game callbacks run asynchronously. Report their URL and handle the
> rejection, otherwise nx.js may terminate before drawing the error.

## `Image` wrapper — deferred dispatch rationale
> MV sometimes attaches its listener just after setting src. Defer native
> image completion one turn so cached files cannot finish before that.
> The wrapper is installed once per process: on a second launch
> (library → play again) globalThis.Image is already this wrapper, and
> wrapping it again would stack deferred dispatches on top of each
> other. The marker skips the re-wrap; the existing wrapper is
> self-contained and keeps working for the new game.

## `Image` wrapper — empty src handling
> MV clears an Image by assigning an empty src. nx.js does not
> implement that browser operation; discard the wrapper's source
> without passing an empty URL to the native decoder.
