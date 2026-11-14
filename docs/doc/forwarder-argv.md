# `forwarder-argv.ts`

Parses the legacy forwarder argv forms (`--game` / `--game-id` / `--mod`) emitted by the old chain-load forwarder mechanism, returning a `ForwarderTarget` (or `null` if no game id was supplied).

## `Forwarder argv parser` (file header / module overview)

> ```
> === Forwarder argv parser ===========================================
> Extracted from main.ts. Parses the legacy `--game <id>` / `--game-id <id>`
> argv forms (and the `--mod` flag) used by the OLD chain-load forwarder
> mechanism. The new baked-in forwarder mechanism (no chain-loading, no
> envSetNextLoad) is detected separately via the __FORWARDER_GAME_ID__
> constant at module init in main.ts.
>
> Supported forms (the forwarder builder emits the first one):
>   --game <id>          (two tokens)
>   --game=<id>          (one token)
>   --game-id <id>       (alias, two tokens)
>   --game-id=<id>       (alias, one token)
>   --mod                (flag — force the mod on at auto-launch)
> ```
