import { assetPath, type Reader } from './library';
import { LocalRequest } from './request';
import { ScriptQueue } from './script-queue';
import { viewport } from './runtime-plan';
import { fixIndexedPng } from './indexed-png';
import { RepeatedPattern } from './repeated-pattern';

type ScriptFilter = (path: string, source: string) => string | null;

/** Only game resources and locally generated blob/data URLs use this bridge.
 * This is not a sandbox: game code still has the runtime's native APIs. */
export function resourceFetch(assets: Reader, nativeFetch: typeof fetch, log: (s: string) => void, pngFix = false): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET');
		if (method.toUpperCase() !== 'GET') throw new TypeError('Only GET resource requests are supported');
		if (/^(?:blob|data):/i.test(url)) return nativeFetch(input, init);
		if (!url.startsWith('romfs:/') && (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//'))) {
			throw new TypeError('External resource URLs are not supported');
		}
		const path = url.replace(/^romfs:\//, '').replace(/^\.\//, '');
		if (!assetPath(path)) throw new TypeError('Unsafe resource path');
		let bytes: ArrayBuffer | null;
		try { bytes = await assets.read(path); }
		catch (error) { log(`Asset read failed: ${path}: ${String(error)}`); throw error; }
		if (bytes === null) log(`Asset fetch missing: ${path}`);
		return bytes === null ? new Response('Not found', { status: 404 }) : new Response(pngFix ? fixIndexedPng(bytes) : bytes);
	};
}

/**
 * RPG Maker MV expects a few browser objects. nx.js already supplies canvas,
 * audio, images and timers; this supplies only the missing document and local
 * resource APIs. It is not a general browser.
 */
export function createBrowserHost(assets: Reader, filter: ScriptFilter, log: (s: string) => void, pngFix = false, directScreen = true, reportRequestError?: (error: Error, responseText: string) => void) {
	let document: any;
	let gameCanvas: CanvasNode | undefined;
	const screenContext = screen.getContext('2d')!;
	const nativeFetch = globalThis.fetch.bind(globalThis);
	let fitScreen = true;
	let queue: ScriptQueue;

	class Node extends EventTarget {
		children: Node[] = [];
		parentNode: Node | null = null;
		style: Record<string, string> = {};
		attributes: Record<string, string> = {};
		id = '';
		className = '';
		textContent = '';
		constructor(public tagName: string) { super(); }
		appendChild(child: Node) {
			child.parentNode = this;
			this.children.push(child);
			if (this === document.body && child instanceof CanvasNode && child.id === 'GameCanvas') {
				gameCanvas = child;
				child.useScreen();
			}
			if (child instanceof ScriptNode && child.src) {
				queue.append(child.src).then(() => child.onload?.(), (error) => { log(`Script failed: ${child.src}: ${String(error)}`); child.onerror?.(error); });
			}
			return child;
		}
		removeChild(child: Node) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentNode = null; return child; }
		remove() { this.parentNode?.removeChild(this); }
		setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
		getAttribute(name: string) { return this.attributes[name] ?? null; }
		getElementsByTagName(name: string): Node[] { const tag = name.toUpperCase(); return this.children.flatMap((node) => [node, ...node.getElementsByTagName(name)]).filter((node) => tag === '*' || node.tagName === tag); }
		getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: screen.width, bottom: screen.height, width: screen.width, height: screen.height }; }
	}
	class CanvasNode extends Node {
		private w = 300; private h = 150;
		private canvas: OffscreenCanvas | typeof screen | undefined;
		private context: any;
		preserveSize = false;
		direct = false;
		revision = 0;
		constructor() { super('CANVAS'); }
		get width() { return this.w; }
		set width(value: number) { if (this.preserveSize && value === this.w) return; this.w = value; this.revision++; if (this.canvas && !this.direct) this.canvas.width = value; }
		get height() { return this.h; }
		set height(value: number) { if (this.preserveSize && value === this.h) return; this.h = value; this.revision++; if (this.canvas && !this.direct) this.canvas.height = value; }
		surface() {
			if (!this.canvas) this.canvas = new OffscreenCanvas(Math.max(1, this.w), Math.max(1, this.h));
			return this.canvas;
		}
		useScreen() {
			// Only the primary game canvas may draw directly to the physical screen.
			if (directScreen && !this.canvas && this.w === screen.width && this.h === screen.height) { this.canvas = screen; this.direct = true; }
		}
		getContext(kind: string) {
			if (kind !== '2d') return null; // Let PIXI choose its Canvas renderer.
			if (this.context) return this.context;
			const target = this.surface().getContext('2d');
			if (!target) return null;
			// PIXI's patterns are unavailable on some nx.js versions. Batch tiny
			// textures into bounded tiles instead of drawing once per pixel.
			let pattern: RepeatedPattern | null = null;
			const saved: (RepeatedPattern | null)[] = [];
			const owner = this;
			const drawing = new Set(['clearRect', 'strokeRect', 'fillText', 'strokeText', 'putImageData', 'fill', 'stroke']);
			// Canvas methods are accessed many times per frame. Reuse wrappers
			// instead of allocating a new bound function for every draw call.
			const methods = new Map<PropertyKey, Function>();
			this.context = new Proxy(target, { get(object, key) {
				if (key === 'fillStyle' && pattern) return pattern;
				const cached = methods.get(key);
				if (cached) return cached;
				const value = (object as any)[key];
				let method: Function | undefined;
				if (key === 'createPattern') method = (image: any, repeat = 'repeat') => {
					const source = image instanceof CanvasNode ? image.surface() : image;
					if (!source?.width || !source?.height) return null;
					return new RepeatedPattern(source, repeat, () => image instanceof CanvasNode ? image.revision : 0);
				};
				else if (key === 'save') method = () => { saved.push(pattern); object.save(); };
				else if (key === 'restore') method = () => { if (saved.length) pattern = saved.pop()!; object.restore(); };
				else if (key === 'fillRect') method = (x: number, y: number, w: number, h: number) => {
					owner.revision++;
					return pattern ? pattern.fill(object, x, y, w, h, (width, height) => new OffscreenCanvas(width, height)) : object.fillRect(x, y, w, h);
				};
				else if (key === 'drawImage') method = (image: any, ...args: any[]) => { owner.revision++; return value.call(object, image instanceof CanvasNode ? image.surface() : image, ...args); };
				else if (typeof key === 'string' && drawing.has(key)) method = (...args: any[]) => { owner.revision++; return value.apply(object, args); };
				else if (typeof value === 'function') method = value.bind(object);
				if (method) { methods.set(key, method); return method; }
				return value;
			}, set(object, key, value) {
				if (key === 'fillStyle' && value instanceof RepeatedPattern) { pattern = value; return true; }
				if (key === 'fillStyle') pattern = null;
				methods.delete(key);
				(object as any)[key] = value; return true;
			} });
			return this.context;
		}
		toDataURL() { return ''; }
	}
	class ScriptNode extends Node {
		src = ''; async = false; onload: (() => void) | null = null; onerror: ((error: unknown) => void) | null = null;
		constructor() { super('SCRIPT'); }
	}
	class MediaNode extends Node {
		src = ''; paused = true; currentTime = 0; duration = 0; volume = 1; playbackRate = 1;
		muted = false; loop = false; autoplay = false; ended = false; readyState = 4; videoWidth = 0; videoHeight = 0;
		play() { this.paused = false; return Promise.resolve(); }
		pause() { this.paused = true; }
		load() { this.dispatchEvent(new Event('loadeddata')); }
		canPlayType() { return 'probably'; }
	}
	const head = new Node('HEAD'), body = new Node('BODY');
	document = new (class extends EventTarget {
		readyState = 'complete'; title = ''; currentScript: ScriptNode | null = null;
		head = head; body = body; documentElement = new Node('HTML');
		fonts = { ready: Promise.resolve(), check: () => true, add() {}, delete() { return false; } };
		createElement(tag: string) {
			switch (tag.toLowerCase()) {
				case 'canvas': return new CanvasNode();
				case 'script': return new ScriptNode();
				case 'audio': case 'video': return new MediaNode(tag.toUpperCase());
				default: return new Node(tag.toUpperCase());
			}
		}
		getElementById(id: string) { return [...head.getElementsByTagName('*'), ...body.getElementsByTagName('*')].find((item) => item.id === id) || null; }
		getElementsByTagName(name: string) { return [...head.getElementsByTagName(name), ...body.getElementsByTagName(name)]; }
		createTextNode(text: string) { const node = new Node('#text'); node.textContent = text; return node; }
		querySelector() { return null; }
	})();
	// FontFaceSet.ready resolves to the set itself, not to undefined.
	document.fonts.ready = Promise.resolve(document.fonts);
	queue = new ScriptQueue(assets, (source, path) => {
		const script = new ScriptNode(); script.src = path; document.currentScript = script;
		try { const prepared = filter(path, source); if (prepared !== null) (0, eval)(`${prepared}\n//# sourceURL=${path}`); }
		finally { document.currentScript = null; }
	});
	class XHR extends LocalRequest {
		constructor() { super(assets); }
		override send() {
			const request = super.send();
			if (reportRequestError) void request.catch((error: unknown) => {
				const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				if (this.responseText) log(`Failed response: ${this.responseURL} (${this.responseText.length} characters)`);
				// Game callbacks run asynchronously. Report their URL and handle the
				// rejection, otherwise nx.js may terminate before drawing the error.
				try { reportRequestError(new Error(`Request ${this.responseURL}: ${detail}`), this.responseText); }
				catch (reportError) { log(`Could not report request error: ${String(reportError)}`); }
			});
			return request;
		}
	}
	Object.assign(globalThis, { document, XMLHttpRequest: XHR, HTMLElement: Node, HTMLCanvasElement: CanvasNode,
		location: { href: 'game:/index.html', pathname: '/index.html', search: '', hash: '', reload() {} },
		innerWidth: screen.width, innerHeight: screen.height, devicePixelRatio: 1 });
	for (const name of ['moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'focus', 'blur', 'close']) if (typeof (globalThis as any)[name] !== 'function') (globalThis as any)[name] = () => {};
	// MV sometimes attaches its listener just after setting src. Defer native
	// image completion one turn so cached files cannot finish before that.
	const NativeImage = globalThis.Image;
	if (NativeImage) {
		(globalThis as any).Image = function() {
			const image = new NativeImage();
			const dispatch = image.dispatchEvent.bind(image);
			image.dispatchEvent = (event: Event) => {
				if (event.type === 'load' || event.type === 'error') { setTimeout(() => dispatch(event), 0); return true; }
				return dispatch(event);
			};
			// MV clears an Image by assigning an empty src. nx.js does not
			// implement that browser operation; discard the wrapper's source
			// without passing an empty URL to the native decoder.
			const source = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(image), 'src');
			if (source?.get && source.set) {
				let empty = false;
				Object.defineProperty(image, 'src', {
					configurable: true,
					get: () => empty ? '' : source.get!.call(image),
					set: (value: string) => { empty = !value; if (!empty) source.set!.call(image, value); },
				});
			}
			image.addEventListener('error', () => log(`Image decode failed: ${image.src}`));
			return image;
		};
		(globalThis as any).Image.prototype = NativeImage.prototype;
	}
	globalThis.fetch = resourceFetch(assets, nativeFetch, log, pngFix);
	return {
		loadScript(path: string) { return queue.append(path); },
		settled() { return queue.settled(); },
		direct() { return !!gameCanvas?.direct; },
		toggleFit() { fitScreen = !fitScreen; return fitScreen; },
		present() {
			if (!gameCanvas || gameCanvas.direct) return;
			const width = fitScreen ? screen.width : Math.min(screen.width, gameCanvas.width);
			const height = fitScreen ? screen.height : Math.min(screen.height, gameCanvas.height);
			const target = viewport(gameCanvas.width, gameCanvas.height, width, height);
			if (!target) return;
			target.x += (screen.width - width) / 2; target.y += (screen.height - height) / 2;
			screenContext.fillStyle = '#000'; screenContext.fillRect(0, 0, screen.width, screen.height);
			screenContext.drawImage(gameCanvas.surface(), 0, 0, gameCanvas.width, gameCanvas.height, target.x, target.y, target.width, target.height);
		},
	};
}
