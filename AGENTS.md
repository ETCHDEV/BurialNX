# Contributor and AI-agent guidance

BurialNX is an unofficial Switch homebrew loader. Keep the loader separate
from game content and do not copy game assets, scripts, saves, mods, or local
logs into the repository. Never write game assets or scripts. The sole
exception inside the selected game directory is its explicitly selected save
folder; exercise that mode only with simulated or disposable test files.

Preserve user saves and settings. Changes to storage identifiers, save keys,
or import/export behavior require a documented migration and tests; never
silently overwrite existing saves. Treat data from games and mods as
untrusted, and validate paths before accessing the SD card.

Keep Switch runtime code independent of Node.js. Node is allowed for local
build tooling and tests only. Keep release diagnostics opt-in and bounded,
and do not claim universal RPG Maker compatibility without hardware testing.
Keep the disabled Credits entry documented until it is tested and fixed on
hardware. Local artwork is not licensed for redistribution by default.
Do not describe the resource bridge as a security sandbox: game and mod
scripts execute with native privileges. See SECURITY.md for the threat model.

Codex (an AI coding assistant) was used to investigate the existing port,
help design and implement this project, run tests, and write documentation.
Contributors remain responsible for reviewing generated changes, licenses,
security, and hardware behavior. Identify additional AI assistance in pull
requests when it materially affects the change.

Before committing, run the tests and build the affected variants; report
anything that could not be verified on real hardware. Never commit secrets,
third-party content without permission, or copyrighted game files.
