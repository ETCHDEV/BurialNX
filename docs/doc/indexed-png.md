# `indexed-png.ts`

Works around a defect in nx.js's native indexed-PNG decoder: when a `tRNS` chunk is present, the palette RGB values are not pre-multiplied with the corresponding alpha, producing washed-out colors. This module detects (via a runtime probe using a synthetic 1-pixel PNG) whether the running nx.js version has the bug and, if so, rewrites the palette in memory before handing the bytes to `Image`.

## `testPng` (module constant)

> A synthetic one-pixel PNG: RGB (200, 100, 50), alpha 128.

## `fixIndexedPng`

> Correct indexed PNG palettes in memory, only after the runtime probe.

## `needsPngFix`

> Test both the defect and correction so newer nx.js versions stay unchanged.
