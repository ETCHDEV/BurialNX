// === Save/Load keymap override =======================================
// Extracted from main.ts. During Scene_Save and Scene_Load, override the
// gamepad keymap to the DEFAULT layout (A=ok, B=cancel) so the user
// always gets standard confirm/cancel buttons in the save menu, even if
// they remapped buttons for gameplay. When the scene changes back to the
// game (Scene_Map etc.), the per-game keymap is restored.
//
// The module owns the `saveLoadKeymapActive` and `savedGamepadMapper`
// flags so they persist across frames. The runtime (globalThis) is read
// via the `globalThis` global — identical to the `runtime` alias in
// main.ts.

import { DEFAULT_KEYMAP } from './keymap';

declare const __DEBUG__: boolean;

export type LogFn = (line: string) => void;

let saveLoadKeymapActive = false;
let savedGamepadMapper: any = null;

export function overrideKeymapForSaveLoadScene(log: LogFn = () => {}): void {
	const runtime = globalThis as any;
	const manager = runtime.SceneManager;
	const scene = manager?._scene;
	if (!scene || !runtime.Scene_Save || !runtime.Input) return;
	const isSaveLoad = scene instanceof runtime.Scene_Save || (runtime.Scene_Load && scene instanceof runtime.Scene_Load);
	if (isSaveLoad && !saveLoadKeymapActive) {
		// Entering save/load scene — save the current mapper and
		// replace it with the default (A=ok, B=cancel, etc.).
		savedGamepadMapper = runtime.Input.gamepadMapper;
		runtime.Input.gamepadMapper = { ...DEFAULT_KEYMAP.buttons.reduce((m, key, i) => { m[i] = key; return m; }, {} as Record<number, string>) };
		saveLoadKeymapActive = true;
		if (__DEBUG__) log('save/load keymap: overridden to default (A=ok, B=cancel)');
	} else if (!isSaveLoad && saveLoadKeymapActive) {
		// Leaving save/load scene — restore the per-game keymap.
		if (savedGamepadMapper) runtime.Input.gamepadMapper = savedGamepadMapper;
		savedGamepadMapper = null;
		saveLoadKeymapActive = false;
		if (__DEBUG__) log('save/load keymap: restored per-game keymap');
	}
}
