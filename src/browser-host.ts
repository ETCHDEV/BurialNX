import { assetPath, type Reader } from './library';
import { LocalRequest } from './request';
import { ScriptQueue } from './script-queue';
import { viewport } from './runtime-plan';
import { fixIndexedPng } from './indexed-png';
import { RepeatedPattern } from './repeated-pattern';
import { S } from './state';

type ScriptFilter = (path: string, source: string) => string | null;

/** Fetch bridge restricted to game resources and local blob/data URLs. */
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

/** Build the minimal browser host (document, XHR, fetch, Image) RPG Maker MV needs. */
export function createBrowserHost(assets: Reader, filter: ScriptFilter, log: (s: string) => void, pngFix = false, directScreen = true, reportRequestError?: (error: Error, responseText: string) => void) {
        let document: any;
        let gameCanvas: CanvasNode | undefined;
        const screenContext = screen.getContext('2d')!;
        const rawFetch = globalThis.fetch as ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & { __burialnxNativeFetch?: typeof globalThis.fetch };
        const nativeFetch = rawFetch?.__burialnxNativeFetch || rawFetch.bind(globalThis);
        let fitScreen = true;
        let queue: ScriptQueue;
        // Cached destination rect for host.present() — the game canvas dimensions and
        // the screen size don't change frame-to-frame, so the viewport math is only
        // redone on resize / fit toggle / screen change. See docs/doc/browser-host.md.
        const presentCache = {
                sw: 0, sh: 0, gw: 0, gh: 0, width: 0, height: 0, fit: false,
                x: 0, y: 0, w: 0, h: 0, valid: false, fullScreen: false,
        };

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
                set width(value: number) {
                        if (S.canvasNodeSkip && value === this.w) return;
                        if (this.preserveSize && value === this.w) return;
                        this.w = value; this.revision++; if (this.canvas && !this.direct) this.canvas.width = value;
                }
                get height() { return this.h; }
                set height(value: number) {
                        if (S.canvasNodeSkip && value === this.h) return;
                        if (this.preserveSize && value === this.h) return;
                        this.h = value; this.revision++; if (this.canvas && !this.direct) this.canvas.height = value;
                }
                surface() {
                        if (!this.canvas) this.canvas = new OffscreenCanvas(Math.max(1, this.w), Math.max(1, this.h));
                        return this.canvas;
                }
                useScreen() {
                        // Only the primary game canvas may draw directly to the physical screen.
                        if (directScreen && !this.canvas && this.w === screen.width && this.h === screen.height) { this.canvas = screen; this.direct = true; }
                }
                getContext(kind: string, ...args: any[]) {
                        // WebGL contexts: pass through to the underlying OffscreenCanvas/screen
                        // WITHOUT proxying. PIXI.js v4 (RPG Maker MV) calls getContext('webgl')
                        // via PIXI.autoDetectRenderer — if this returns a real WebGL context, it
                        // uses the GPU-accelerated WebGLRenderer (far faster than Canvas2D). If the
                        // underlying canvas doesn't support WebGL, null is returned and PIXI falls
                        // back to Canvas2D — no regression. The 2d Proxy below is NOT applied to
                        // WebGL contexts (it's specific to CanvasRenderingContext2D).
                        if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') {
                                const target = this.canvas || this.surface();
                                if (target && typeof (target as any).getContext === 'function') {
                                        return (target as any).getContext(kind, ...args);
                                }
                                return null;
                        }
                        if (kind !== '2d') return null;
                        if (this.context) return this.context;
                        const target = this.surface().getContext('2d');
                        if (!target) return null;
                        // Explicit wrapper (pre-bound methods + property accessors) instead of a
                        // Proxy — avoids per-call trap overhead on every Canvas2D operation.
                        // See docs/doc/browser-host.md for the rationale.
                        const owner = this;
                        let pattern: RepeatedPattern | null = null;
                        const saved: (RepeatedPattern | null)[] = [];
                        const ctx: any = {};
                        const bindNative = (obj: any) => {
                                if (!obj) return;
                                for (const key of Object.getOwnPropertyNames(obj)) {
                                        if (key === 'constructor' || key in ctx) continue;
                                        let value: any;
                                        try { value = obj[key]; } catch { continue; }
                                        if (typeof value === 'function') ctx[key] = value.bind(target);
                                }
                        };
                        bindNative(target);
                        try { bindNative(Object.getPrototypeOf(target)); } catch { /* best-effort */ }
                        for (const prop of [
                                'strokeStyle', 'globalAlpha', 'globalCompositeOperation',
                                'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
                                'font', 'textAlign', 'textBaseline', 'direction',
                                'imageSmoothingEnabled', 'imageSmoothingQuality',
                                'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
                                'filter', 'webkitFilter',
                                'webkitImageSmoothingEnabled', 'mozImageSmoothingEnabled',
                                'oImageSmoothingEnabled', 'msImageSmoothingEnabled',
                                'webkitBackingStorePixelRatio',
                        ]) {
                                Object.defineProperty(ctx, prop, {
                                        configurable: true, enumerable: true,
                                        get: () => (target as any)[prop],
                                        set: (v: any) => { (target as any)[prop] = v; },
                                });
                        }
                        Object.defineProperty(ctx, 'fillStyle', {
                                configurable: true, enumerable: true,
                                get: () => pattern || target.fillStyle,
                                set: (v: any) => { if (v instanceof RepeatedPattern) pattern = v; else { pattern = null; target.fillStyle = v; } },
                        });
                        Object.defineProperty(ctx, 'canvas', { configurable: true, enumerable: true, get: () => (target as any).canvas });
                        ctx.createPattern = function(image: any, repeat = 'repeat') {
                                const source = image instanceof CanvasNode ? image.surface() : image;
                                if (!source?.width || !source?.height) return null;
                                return new RepeatedPattern(source, repeat, () => image instanceof CanvasNode ? image.revision : 0);
                        };
                        ctx.save = function() { saved.push(pattern); target.save(); };
                        ctx.restore = function() { if (saved.length) pattern = saved.pop()!; target.restore(); };
                        ctx.fillRect = function(x: number, y: number, w: number, h: number) {
                                owner.revision++;
                                if (pattern) return pattern.fill(target, x, y, w, h, (width: number, height: number) => new OffscreenCanvas(width, height));
                                return target.fillRect(x, y, w, h);
                        };
                        ctx.drawImage = function(image: any, ...args: any[]) {
                                owner.revision++;
                                return target.drawImage(image instanceof CanvasNode ? image.surface() : image, ...args);
                        };
                        for (const key of ['clearRect', 'strokeRect', 'fillText', 'strokeText', 'putImageData', 'fill', 'stroke']) {
                                const fn = (target as any)[key];
                                if (typeof fn === 'function') ctx[key] = function(...args: any[]) { owner.revision++; return fn.apply(target, args); };
                        }
                        this.context = ctx;
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
        const NativeImage = globalThis.Image as any;
        if (NativeImage && !NativeImage.__burialnxWrapped) {
                const wrapped = function() {
                        const image = new NativeImage();
                        const dispatch = image.dispatchEvent.bind(image);
                        image.dispatchEvent = (event: Event) => {
                                if (event.type === 'load' || event.type === 'error') { setTimeout(() => dispatch(event), 0); return true; }
                                return dispatch(event);
                        };
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
                (wrapped as any).__burialnxWrapped = true;
                wrapped.prototype = NativeImage.prototype;
                (globalThis as any).Image = wrapped;
        }
        const resourceBridge = resourceFetch(assets, nativeFetch, log, pngFix) as any;
        resourceBridge.__burialnxNativeFetch = nativeFetch;
        globalThis.fetch = resourceBridge;
        return {
                loadScript(path: string) { return queue.append(path); },
                settled() { return queue.settled(); },
                direct() { return !!gameCanvas?.direct; },
                toggleFit() { fitScreen = !fitScreen; return fitScreen; },
                present() {
                        if (!gameCanvas || gameCanvas.direct) return;
                        const sw = screen.width, sh = screen.height;
                        const gw = gameCanvas.width, gh = gameCanvas.height;
                        const width = fitScreen ? sw : Math.min(sw, gw);
                        const height = fitScreen ? sh : Math.min(sh, gh);
                        // Cache the dest rect (toggle S.presentCache). When off, the cache is
                        // bypassed so the rect is recomputed every present() (stock behavior).
                        const cacheMiss = !S.presentCache
                                || sw !== presentCache.sw || sh !== presentCache.sh
                                || gw !== presentCache.gw || gh !== presentCache.gh
                                || width !== presentCache.width || height !== presentCache.height
                                || fitScreen !== presentCache.fit;
                        if (cacheMiss) {
                                const t = viewport(gw, gh, width, height);
                                if (!t) { presentCache.valid = false; return; }
                                t.x += (sw - width) / 2; t.y += (sh - height) / 2;
                                presentCache.x = t.x; presentCache.y = t.y; presentCache.w = t.width; presentCache.h = t.height;
                                presentCache.sw = sw; presentCache.sh = sh; presentCache.gw = gw; presentCache.gh = gh;
                                presentCache.width = width; presentCache.height = height; presentCache.fit = fitScreen;
                                presentCache.fullScreen = (t.x === 0 && t.y === 0 && t.width === sw && t.height === sh);
                                presentCache.valid = true;
                        }
                        if (!presentCache.valid) return;
                        const dx = presentCache.x, dy = presentCache.y, dw = presentCache.w, dh = presentCache.h;
                        if (!presentCache.fullScreen) {
                                screenContext.fillStyle = '#000';
                                if (dy > 0) screenContext.fillRect(0, 0, sw, dy);
                                if (dy + dh < sh) screenContext.fillRect(0, dy + dh, sw, sh - (dy + dh));
                                if (dx > 0) screenContext.fillRect(0, dy, dx, dh);
                                if (dx + dw < sw) screenContext.fillRect(dx + dw, dy, sw - (dx + dw), dh);
                        }
                        // A2 (toggle S.smoothingOff): nearest downscale for the present() draw.
                        // See docs/doc/fps-optimizations.md. Restored after so other draws are unaffected.
                        const prevSmooth = screenContext.imageSmoothingEnabled;
                        if (S.smoothingOff) screenContext.imageSmoothingEnabled = false;
                        screenContext.drawImage(gameCanvas.surface(), 0, 0, gw, gh, dx, dy, dw, dh);
                        if (S.smoothingOff) screenContext.imageSmoothingEnabled = prevSmooth;
                },
        };
}
