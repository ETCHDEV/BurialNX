# `save-slots.ts`

This module provides a read-only compatibility layer over the previous loader's localStorage save-key namespace. It generates the legacy slot keys for an external slot picker and lists which slots actually exist, without modifying any saves; the game code remains responsible for loading.

## `saveKey`

> Match the previous loader's key namespace without modifying any saves.

## `listExistingSlots`

> A read-only view for an external slot picker; game code remains responsible for loading.
