import type { Reader } from './library';
import { interactionTextY } from './dialogue';
import { fixIndexedPng } from './indexed-png';

/**
 * Two desktop-only plugins cannot run on nx.js. Use MV audio instead of the
 * streaming Worker, and omit only the appended Node payload from the region
 * plugin. The region collision rules themselves must remain enabled.
 */
export function prepareGameScript(path: string, source: string): string | null {
	if (path.endsWith('/AudioStreaming.js')) return null;
	if (path.endsWith('/YEP_RegionRestrictions.js') && source.includes("'zlib'") && source.includes('Buffer[')) {
		// The injected payload occupies one line after the closing `};` of a
		// real method. The rest of the plugin follows on later lines and must
		// remain intact (it defines the movement and region helpers).
		const lines = source.split('\n');
		const injected = lines.flatMap((line, index) =>
			line.startsWith('};(function(') && line.includes("'zlib'") && line.includes('Buffer[') ? [index] : []);
		if (injected.length !== 1) throw new Error('Unrecognized region plugin: cannot remove Node payload safely');
		lines[injected[0]] = '};';
		return lines.join('\n');
	}
	return source;
}

type Language = Record<string, Record<string, string | string[]>>;

export async function languageTable(assets: Reader): Promise<Language | null> {
	const data = await assets.read('data/9c7050ae76645487');
	if (!data) return null;
	const text = new TextDecoder().decode(data);
	if (!text.startsWith('LANGDATA')) throw new Error('Unsupported language data');
	return JSON.parse(text.slice(8));
}

export function translate(input: string, table: Language): string {
	const names: Record<string, string> = { lines: 'linesLUT', label: 'labelLUT', syslabel: 'sysLabel', sysmenus: 'sysMenus' };
	return input.replace(/\((lines|label|sysLabel|sysMenus)\)\[([^\]]+)\]/gi, (whole, type: string, key: string) => {
		const value = table[names[type.toLowerCase()]]?.[key];
		return Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : whole;
	});
}

/** Fonts are read from the game's own stylesheet and remain outside the NRO. */
export async function registerFonts(assets: Reader, runtime: any): Promise<void> {
	const file = await assets.read('fonts/gamefont.css');
	if (!file || !runtime.FontFace || !runtime.fonts?.add) return;
	const css = new TextDecoder().decode(file);
	for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
		const family = /font-family\s*:\s*["']?([^;"']+)/i.exec(block[1])?.[1].trim();
		const path = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(block[1])?.[1].trim();
		if (!family || !path || /^(?:[a-z]+:|\/)/i.test(path)) continue;
		const bytes = await assets.read(`fonts/${path}`);
		if (!bytes) continue;
		for (const face of [{}, { weight: 'bold' }, { style: 'italic' }, { style: 'italic', weight: 'bold' }]) {
			runtime.fonts.add(new runtime.FontFace(family, bytes, face));
		}
	}
}

/** Install after plugins load, before window.onload starts the game. */
export function installGameCompatibility(runtime: any, root: string, sharedSaves: boolean, language: Language | null, pngFix = false) {
	// The bundled credits scene is currently unreliable on nx.js. Keep its
	// title entry visible but disabled and make event-script calls harmless.
	// Remove this guard only after the credits scene is tested on hardware.
	const credits = runtime.Galv?.CRED;
	if (typeof credits?.start === 'function') {
		credits.start = () => {};
		const title = runtime.Scene_Title?.prototype;
		if (title && typeof title.commandCredits === 'function') title.commandCredits = function() {
			runtime.SoundManager?.playBuzzer?.();
			this._commandWindow?.activate?.();
		};
		const commands = runtime.Window_TitleCommand?.prototype;
		if (typeof commands?.makeCommandList === 'function') {
			const make = commands.makeCommandList;
			commands.makeCommandList = function() {
				make.apply(this, arguments);
				for (const command of this._list || []) if (command.symbol === 'credits') command.enabled = false;
			};
		}
	}
	if (pngFix && typeof runtime.Decrypter?.createBlobUrl === 'function') {
		const original = runtime.Decrypter.createBlobUrl;
		runtime.Decrypter.createBlobUrl = function(bytes: ArrayBuffer) { return original.call(this, fixIndexedPng(bytes)); };
	}
	if (runtime.Input) runtime.Input.gamepadMapper = {
		0: 'cancel', 1: 'ok', 2: 'shift', 3: 'menu', 4: 'pageup', 5: 'pagedown', 9: 'menu',
		12: 'up', 13: 'down', 14: 'left', 15: 'right',
	};
	// MV normally keeps a pool of Image objects. Native images can retain their
	// pixel buffers and bound listeners, so release those references on cleanup.
	const bitmap = runtime.Bitmap;
	if (bitmap?.prototype?._clearImgInstance) {
		const clear = bitmap.prototype._clearImgInstance;
		bitmap.prototype._clearImgInstance = function() {
			const image = this._image;
			if (this._loadListener) image?.removeEventListener?.('load', this._loadListener);
			if (this._errorListener) image?.removeEventListener?.('error', this._errorListener);
			const result = clear.apply(this, arguments);
			const pool = bitmap._reuseImages;
			if (Array.isArray(pool)) { const index = pool.indexOf(image); if (index >= 0) pool.splice(index, 1); }
			return result;
		};
	}
	// WindowLayer explicitly clears its temporary canvas each frame. Avoid
	// repeatedly allocating a same-sized native surface for that one canvas.
	const layer = runtime.WindowLayer?.prototype;
	if (layer?.renderCanvas) {
		const render = layer.renderCanvas;
		layer.renderCanvas = function() {
			const canvas = this._tempCanvas;
			if (canvas) canvas.preserveSize = true;
			try { return render.apply(this, arguments); }
			finally { if (canvas) canvas.preserveSize = false; }
		};
	}
	const storage = runtime.StorageManager;
	if (!sharedSaves && typeof storage?.webStorageKey === 'function') {
		const original = storage.webStorageKey;
		storage.webStorageKey = function(...args: unknown[]) { return `NX:${encodeURIComponent(root.replace(/\/+$/, ''))}:` + original.apply(this, args); };
	}
	// The game's skipped desktop helper provides autoSave(). Keep its recovery
	// snapshot separate from ordinary slots so it cannot overwrite the player.
	const manager = runtime.DataManager;
	if (manager?.setupNewGame) {
		const setup = manager.setupNewGame;
		manager.setupNewGame = function() {
			const result = setup.apply(this, arguments);
			// This game's intro card uses this known starting position and its
			// first transfer makes the player visible again.
			if (runtime.$dataSystem?.startMapId === 15 && runtime.$dataSystem.startX === 8 && runtime.$dataSystem.startY === 7) runtime.$gamePlayer?.setTransparent?.(true);
			return result;
		};
	}
	if (manager && typeof manager.autoSave !== 'function') manager.autoSave = function() {
		try {
			const data = runtime.JsonEx.stringify(this.makeSaveContents());
			// Do not overwrite recovery snapshots made by the previous loader.
			runtime.localStorage.setItem(`BurialNX Autosave:${encodeURIComponent(root)}`, runtime.LZString.compressToBase64(data));
			return true;
		} catch { return false; }
	};
	if (language) {
		const message = runtime.Game_Message?.prototype;
		if (message) {
			const add = message.add, choices = message.setChoices;
			message.add = function(text: string) { return add.call(this, typeof text === 'string' ? translate(text, language) : text); };
			message.setChoices = function(list: string[], ...rest: unknown[]) { return choices.call(this, list.map((s) => translate(s, language)), ...rest); };
		}
		for (const [prototype, method] of [[runtime.Window_Base?.prototype, 'convertEscapeCharacters'], [runtime.Bitmap?.prototype, 'drawText'], [runtime.Bitmap?.prototype, 'measureTextWidth']] as const) {
			const original = prototype?.[method];
			if (typeof original === 'function') prototype[method] = function(text: unknown, ...rest: unknown[]) {
				return original.call(this, typeof text === 'string' ? translate(text, language) : text, ...rest);
			};
		}
	}
	// nx.js exposes StereoPanner, whereas MV requests the older 3D panner.
	const audio = runtime.WebAudio;
	if (audio) {
		const create = audio._createContext;
		audio._createContext = function() {
			create.call(this);
			const context = this._context;
			if (context?.createStereoPanner) context.createPanner = () => {
				const node = context.createStereoPanner();
				node.setPosition = (x: number) => node.pan.setValueAtTime(Math.max(-1, Math.min(1, x)), context.currentTime);
				return node;
			};
		};
		audio.prototype._onXhrLoad = function(xhr: any) {
			try {
				const bytes = runtime.Decrypter?.hasEncryptedAudio ? runtime.Decrypter.decryptArrayBuffer(xhr.response) : xhr.response;
				this._readLoopComments(new Uint8Array(bytes));
				Promise.resolve(audio._context.decodeAudioData(bytes)).then((buffer: any) => {
					this._buffer = buffer; this._totalTime = buffer.duration;
					if (this._loopLength > 0 && this._sampleRate > 0) { this._loopStart /= this._sampleRate; this._loopLength /= this._sampleRate; }
					else { this._loopStart = 0; this._loopLength = buffer.duration; }
					this._onLoad();
				}, () => { this._hasError = true; });
			} catch { this._hasError = true; }
		};
	}
	// Anonymous center-screen interaction text has excess empty space in MV.
	const nameBox = runtime.Window_NameBox?.prototype;
	if (nameBox?.adjustPositionY) {
		const adjust = nameBox.adjustPositionY;
		nameBox.adjustPositionY = function() {
			adjust.apply(this, arguments);
			const parent = this._parentWindow;
			if (parent && this.y < parent.y + parent.height && this.y + this.height > parent.y) {
				const above = parent.y + (parent.padding || 0) - (this.padding || 0) - (this.lineHeight?.() || this.height) - 4;
				if (above >= 0) this.y = above;
			}
			this._burialOffset = 0;
		};
	}
	const message = runtime.Window_Message?.prototype;
	if (message?.newPage) {
		const original = message.newPage;
		message.newPage = function(state: any) {
			const result = original.call(this, state);
			if (runtime.$gameMessage?.positionType?.() === 2 && typeof state?.text === 'string') {
				const page = state.text.slice(state.index || 0).split('\f')[0];
				const spare = Math.max(0, (this.contents?.height || 0) - state.height * page.split('\n').length);
				const shift = Math.min(36, spare);
				state.y += shift;
				if (this._nameWindow?.active) { this._nameWindow.y += shift - (this._nameWindow._burialOffset || 0); this._nameWindow._burialOffset = shift; }
			} else if (runtime.$gameMessage?.positionType?.() === 1 && !this._nameWindow?.active && typeof state?.text === 'string') {
				const page = state.text.slice(state.index || 0).split('\f')[0].replace(/\n+$/, '');
				const height = state.height * Math.max(1, page.split('\n').length);
				state.y += interactionTextY(this.contents?.height, height, 0);
			}
			return result;
		};
	}
}
