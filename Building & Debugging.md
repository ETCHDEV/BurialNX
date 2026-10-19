# Building and debugging

The build uses Node.js on the build computer and packages a self-contained
nx.js runtime in each NRO. It does not use Node.js on the Switch. No game files
are needed to build or run the unit tests. The user reports successful Switch
gameplay, but not every feature or configuration has been verified.

## Prerequisites

Install Node.js 22 or newer with npm. A fresh install needs registry access.
The locked npm packages include esbuild and `@nx.js/nro`. A native devkitPro
toolchain is not required for this packaging workflow: the nx.js package
supplies the prebuilt runtime. Building nx.js itself from source is a separate
task. The packaging tool may need a terminal capable of showing an icon preview.

## Linux and macOS

From a terminal in the project directory:

```sh
npm ci
npm test
npm run build
npm run build -- --debug
```

To run the optional desktop smoke test with your own game, point to the
directory containing the game's `index.html` (usually `www`):

```sh
BURIALNX_GAME_ROOT="/path/to/your/game/www" npm run smoke
```

This simulates graphics, audio, and storage; it is not a substitute for a
Switch test. The test only reads the game folder.

## Windows

Install Node.js for Windows, open PowerShell in the project directory, and run:

```powershell
npm ci
npm test
npm run build
npm run build -- --debug
```

For the optional smoke test in PowerShell:

```powershell
$env:BURIALNX_GAME_ROOT = 'C:\path\to\your\game\www'
npm run smoke
```

If PowerShell's local execution policy blocks npm's script wrapper, use
`npm.cmd` for the same commands. Windows and Linux builds have not yet been
verified by this project's maintainers; please report issues with versions and
logs. macOS packaging and the JavaScript unit tests have been exercised.

## Outputs and artwork

The normal build writes `burialnx.nro`; the debug flag writes
`burialnx-debug.nro` without replacing the release file. Both are fat packages
and appear as `BurialNX` and `BurialNX-Debug` in the homebrew menu, respectively.
They share the same application ID for existing saves and do not require a
separate nx.js NRO on the SD card. Copy the desired NRO
to `sdmc:/switch/burialnx/` on a homebrew-enabled console. Use title
override/application mode rather than the constrained Album applet mode.

To use custom artwork, put `icon.jpg` or `icon.png` in the project root before
running either build command. If both files exist, `icon.jpg` takes precedence.
The build converts PNG images and JPEG images of other sizes to the 256×256
JPEG required by the NRO packager. Images are fitted without distortion, with
black padding and transparency composited over black. A 256×256 JPEG is used
unchanged. Invalid images fail the build; images are limited to 16 MiB and
16 megapixels. If neither file exists, nx.js's placeholder is embedded.

Both filenames are deliberately ignored by Git. Supply artwork only if you have
permission to use and distribute it, and verify its license before publishing
an NRO that embeds it.
An image found online is not automatically licensed for redistribution. Local
NROs built with artwork of unknown origin must not be treated as public
releases until the rights are confirmed. The image is not included in Git.

To explicitly use the nx.js placeholder even if a local icon is present, build
the release artifacts with:

```sh
npm run build -- --default-icon
npm run build -- --debug --default-icon
```

The flag does not remove or change local artwork. Confirm the license and
notice obligations for the exact bundled runtime and its components before
publishing either NRO; a placeholder icon alone is not a complete rights review.

## Preparing a GitHub release

Commit the source and documentation, but not game files, saves, mods, logs,
dependencies, local artwork, or NROs. The NROs are ignored by Git; attach the
two built files separately to a GitHub Release for the matching version tag.
The release build is intended for normal play, and the debug build is intended
for diagnosing problems. Both contain the same application ID to preserve the
existing Switch save namespace.

Check that the NRO version matches `package.json`, review the exact bundled
runtime and font notices, and test the builds on hardware when possible. An
automated test or a successful build does not establish performance, long-term
stability, or legal permission to redistribute the packaged components.

## Runtime and development files

The build uses a unique temporary staging directory and removes it afterward.
Build output, dependencies, game files, saves, mods and logs are ignored by
Git. Rebuilding an output replaces that specific output file. Source maps,
dependencies, and the embedded runtime must be reviewed for third-party
notices before distributing a release; see [NOTICE.md](NOTICE.md).

## Debugging on Switch

1. Back up your saves. Build `burialnx-debug.nro` with the debug command above,
   copy it to `sdmc:/switch/burialnx/`, launch it in application mode, and
   select the same Switch user used for the affected save.
2. The debug build asks for the game, mod, and save location on every launch. Choose the same
   game, save location and mod used when the problem occurred. To isolate a
   mod issue, repeat with no mod when practical.
3. Reproduce the problem and note exactly what you did, what you expected,
   and what appeared instead. Include whether it occurred at startup, in a
   particular room, on a menu, during a transition, or after resuming from
   HOME. Take a photo of any on-screen error if possible.
4. If the game is still responsive, hold Minus for the debug menu and choose
   **Write diagnostic snapshot**. B closes the menu. The menu also offers an
   FPS display and a direct-screen setting that applies on the next launch.
5. Before launching the loader again or another nx.js application, copy:

   - `sdmc:/switch/burialnx/LOGS/native-host.log` — loader output, appended
     across sessions. Include the latest `BurialNX debug session` header and
     all following lines. An early startup failure can leave no new session.
   - The newest `sdmc:/switch/burialnx/LOGS/nxjs-debug-<timestamp>.log` snapshot,
     if one exists. Snapshots can be older than the crash.
   - `sdmc:/switch/nxjs-debug.log` — nx.js's live log, which may contain newer
     runtime information than the last snapshot.
   - For an Atmosphère crash, the relevant recent report under
     `sdmc:/atmosphere/crash_reports/` or `sdmc:/atmosphere/fatal_errors/`,
     or the path displayed on the error screen, if present. Report location
     and file type depend on the crash and Atmosphère version.

6. Send the relevant logs to the maintainer along with the loader build or
   commit, game version, Switch/Atmosphère versions, launch mode, selected
   save backend, whether a mod was enabled, and reproducible steps. Say if
   a requested file was missing; don't create a substitute or delete logs.

Review logs before sharing: they can contain paths, mod names, account-related
details, and other private information. Redact secrets and personal details
without removing the error and surrounding context. Do not upload game files,
save files, mods, or copyrighted assets. Share sensitive security findings
privately as described in [SECURITY.md](SECURITY.md).

Debug logging and snapshots can add overhead and use SD space. The normal
release build suppresses routine loader logging; nx.js or Atmosphère may still
write their own logs. A native crash, power loss, or hang can prevent a final
log entry or snapshot, so a missing log does not prove that no error occurred.
