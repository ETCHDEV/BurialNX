# Security

## Trust boundary

BurialNX runs JavaScript supplied by the selected game and its optional mods
in the same nx.js runtime as the loader. This is **not a sandbox**. A malicious
or compromised game, mod, native dependency, or homebrew environment can use
native APIs to access the SD card or network, and potentially affect other
data. Only use game files and mods from sources you trust, back up saves, and
disconnect the Switch from networks if you do not need network access. Mod
files override game files and can include executable scripts.

The loader's own source does not intentionally create a network listener.
Its resource fetch bridge accepts local game assets and local blob/data URLs,
and rejects HTTP, network-path, native filesystem and other external URLs.
This limits accidental requests through that bridge; scripts still have access
to [nx.js native networking APIs](https://nxjs.n8.io/runtime/api/namespaces/Switch),
so it does **not** prove the runtime is offline or
prevent a malicious script from opening ports or making connections. No live
Switch network scan or independent audit of nx.js and its native dependencies
has been performed.

Path checks reject traversal and control characters in loader-managed paths.
Game assets and mod folders are treated as read-only by loader code. If the
user explicitly selects a game-folder save directory, saves and recovery
files are written there. The file-save backend avoids recursive deletion of directories and keeps recovery copies
for interrupted writes. None of these measures confines code from a game or
mod, nor should they replace backups or a review of third-party files.

## Reporting

Do not publish working exploits, private logs, personal data, or game files in
a public issue. Use GitHub's private vulnerability reporting if the project
maintainer enables it, or contact the maintainer privately using a trusted
channel. Give a minimal reproduction, affected revision, impact, and sanitized
logs. If no private contact is available, ask the maintainer for one without
posting exploit details.

## Dependency checks

Run `npm audit --ignore-scripts` when preparing a release. This contacts the
configured npm registry and shares dependency names and versions. An audit
does not examine the shipped native runtime binary, unlisted native libraries,
game assets, or unreported vulnerabilities and is not a security guarantee.
The maintainer should independently review the runtime, native dependencies,
licenses and release artifacts.
