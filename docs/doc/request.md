# `request.ts`

Minimal asynchronous local GET requests for future RPG Maker integration. A small `EventTarget` subclass (`LocalRequest`) that mimics enough of `XMLHttpRequest` to satisfy RPG Maker's asset-loading API: `open`, `send`, `overrideMimeType`, `responseType`, and `onload`/`onerror`/`onreadystatechange` callbacks, all backed by the local `Reader` asset source rather than the network.

## `LocalRequest` (class doc)
> /** Minimal asynchronous local GET requests for future RPG Maker integration. */

## `LocalRequest.overrideMimeType`
> /* the response type controls decoding */

## `LocalRequest.send` — game-callback dispatch
> // Invoke game callbacks outside the I/O error handler: an exception in
> // game code must not be reported as a missing file and retried forever.
