# `library.ts`

Filesystem boundary helpers: a `Reader` interface for read-only game/mod access, an `assetPath` guard that rejects unsafe paths (traversal, control chars, native scheme separators), and an `overlayReader` that lets a loose mod file override the game file.

## `Reader`
> Filesystem boundary for a read-only game and an optional read-only mod.

## `assetPath`
> Only relative paths are accepted; decoding must not turn a path into traversal.

## `assetPath` — character rejection
> Control characters can forge log lines or escape a sourceURL comment;
> colons and backslashes can introduce native filesystem schemes/paths.

## `overlayReader`
> A loose file in the mod directory takes precedence over the game file.
