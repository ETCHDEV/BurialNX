/** Node.js/NW.js compatibility shims (require, process, Buffer, fs, nw) for RPG Maker MV games. */

import { libraryIdFromRoot } from './game-library';

/** Subset of nx.js's `Switch` global used for synchronous file I/O. */
export interface SwitchFs {
        readFileSync(path: string): ArrayBuffer | null;
        writeFileSync(path: string, value: string | ArrayBuffer): void;
        removeSync?(path: string): void;
        unlinkSync?(path: string): void;
        mkdirSync?(path: string): void;
        statSync(path: string): { mode: number } | null;
        readDirSync?(path: string): string[] | null;
        readFile(path: string): Promise<ArrayBuffer | null>;
        appendFileSync?(path: string, value: string | ArrayBuffer): void;
}

export interface NodeCompatOptions {
        /** Absolute SD path of the game www root (the loader's `selectedGame`). */
        gameRoot: string;
        /** Optional logger (debug builds). */
        log?: (s: string) => void;
}

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const NWFS_BASE = 'sdmc:/switch/burialnx/nwfs';

const nextMicrotask: (fn: () => void) => void =
        typeof (globalThis as any).queueMicrotask === 'function'
                ? (fn) => (globalThis as any).queueMicrotask(fn)
                : (fn) => setTimeout(fn, 0);

/** The NW.js "app root" (directory of the .exe / parent of `www`). */
export function appRootFrom(gameRoot: string): string {
        const clean = gameRoot.replace(/\/+$/, '');
        return clean.toLowerCase().endsWith('/www') ? clean.slice(0, -4) : clean;
}

/** Per-game writable overlay directory (`sdmc:/switch/burialnx/nwfs/<id>`). */
export function overlayBaseFor(gameRoot: string): string {
        return `${NWFS_BASE}/${libraryIdFromRoot(gameRoot)}`;
}

/** Resolve an fs path against the NW.js app root to a safe absolute sdmc:/ path. */
export function resolveFsPath(gameRoot: string, raw: string): string | null {
        let p = String(raw ?? '');
        if (!p) return null;
        p = p.split('?')[0].split('#')[0];
        const url = /^(?:file|nwjs|nw):\/\//i.exec(p);
        if (url) {
                const rest = p.slice(url[0].length);
                const slash = rest.indexOf('/');
                let path = slash >= 0 ? decodeURIComponent(rest.slice(slash + 1)) : '';
                if (/^[a-z]:[\\/]/i.test(path)) path = path.slice(2);
                path = path.replace(/\\/g, '/').replace(/^\/+/, '');
                const segs = path.split('/').filter((s) => s && s !== '.');
                if (segs.some((s) => s === '..')) return null;
                return `sdmc:/${segs.join('/')}`;
        }
        // Absolute sdmc:/ path: validate as-is.
        if (/^sdmc:\//i.test(p)) {
                const rest = p.replace(/^sdmc:\//i, '').replace(/\/+$/, '');
                if (!rest || /[\\:\u0000-\u001f\u007f\u2028\u2029]/.test(rest)) return null;
                if (rest.split('/').some((s) => !s || s === '.' || s === '..')) return null;
                return `sdmc:/${rest}`;
        }
        // Strip a Windows drive letter; normalize backslashes.
        if (/^[a-z]:[\\/]/i.test(p)) p = p.slice(2);
        p = p.replace(/\\/g, '/');
        if (p.startsWith('/')) p = p.slice(1);
        const segs = p.split('/').filter((s) => s && s !== '.');
        if (segs.some((s) => s === '..')) return null;
        const root = appRootFrom(gameRoot).replace(/^sdmc:\//i, '');
        return `sdmc:/${root}/${segs.join('/')}`;
}

/** Relative path (POSIX, no leading slash) from the app root to `resolved`. */
function relFromAppRoot(gameRoot: string, resolved: string): string | null {
        const root = appRootFrom(gameRoot).replace(/\/+$/, '').toLowerCase();
        const target = resolved.replace(/\/+$/, '').toLowerCase();
        if (target === root) return '';
        if (!target.startsWith(root + '/')) return null;
        return resolved.slice(root.length + 1).replace(/\/+$/, '');
}


function encodeUtf8(input: string): number[] {
        const out: number[] = [];
        for (let i = 0; i < input.length; i++) {
                let code = input.charCodeAt(i);
                if (code < 0x80) { out.push(code); continue; }
                if (code >= 0xd800 && code <= 0xdbff) {
                        const next = input.charCodeAt(++i);
                        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                }
                if (code < 0x800) out.push(0xc0 | (code >> 6));
                else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f));
                else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f));
                out.push(0x80 | (code & 0x3f));
        }
        return out;
}

function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
        let s = '';
        let i = start;
        const limit = Math.min(end, bytes.length);
        while (i < limit) {
                const b1 = bytes[i++];
                if (b1 < 0x80) { s += String.fromCharCode(b1); continue; }
                let code: number;
                if ((b1 & 0xe0) === 0xc0) { code = ((b1 & 0x1f) << 6) | (bytes[i++] & 0x3f); }
                else if ((b1 & 0xf0) === 0xe0) { code = ((b1 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f); }
                else { code = ((b1 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f); }
                if (code > 0xffff) {
                        code -= 0x10000;
                        s += String.fromCharCode(0xd800 | (code >> 10), 0xdc00 | (code & 0x3ff));
                } else s += String.fromCharCode(code);
        }
        return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encodeBase64(bytes: Uint8Array, start: number, end: number): string {
        let out = '';
        let i = start;
        const limit = Math.min(end, bytes.length);
        while (i < limit) {
                const a = bytes[i++] || 0, b = i < limit ? bytes[i++] : -1, c = i < limit ? bytes[i++] : -1;
                out += B64[a >> 2];
                out += B64[((a & 3) << 4) | (b >= 0 ? b >> 4 : 0)];
                out += b < 0 ? '=' : B64[((b & 15) << 2) | (c >= 0 ? c >> 6 : 0)];
                out += c < 0 ? '=' : B64[c & 63];
        }
        return out;
}

function decodeBase64(str: string): number[] {
        const clean = str.replace(/[^A-Za-z0-9+/]/g, '');
        const out: number[] = [];
        for (let i = 0; i < clean.length; i += 4) {
                const a = B64.indexOf(clean[i]), b = B64.indexOf(clean[i + 1] ?? '='), c = B64.indexOf(clean[i + 2] ?? '='), d = B64.indexOf(clean[i + 3] ?? '=');
                out.push((a << 2) | (b >> 4));
                if (c >= 0 && clean[i + 2] !== '=') out.push(((b & 15) << 4) | (c >> 2));
                if (d >= 0 && clean[i + 3] !== '=') out.push(((c & 3) << 6) | d);
        }
        return out;
}

function encodeHex(bytes: Uint8Array, start: number, end: number): string {
        let out = '';
        const limit = Math.min(end, bytes.length);
        for (let i = start; i < limit; i++) { const h = bytes[i].toString(16); out += h.length < 2 ? '0' + h : h; }
        return out;
}

function decodeHex(str: string): number[] {
        const clean = str.replace(/[^0-9a-fA-F]/g, '');
        const out: number[] = [];
        for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
        return out;
}

class MiniBuffer extends Uint8Array {
        static from(value: any, encodingOrOffset?: any, length?: number): MiniBuffer {
                if (typeof value === 'string') {
                        const enc = typeof encodingOrOffset === 'string' ? encodingOrOffset.toLowerCase() : 'utf8';
                        const bytes = enc === 'base64' ? decodeBase64(value) : enc === 'hex' ? decodeHex(value) : enc === 'latin1' || enc === 'binary' ? Array.from(value, (c: string) => c.charCodeAt(0)) : encodeUtf8(value);
                        return new MiniBuffer(bytes);
                }
                if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                        const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength);
                        const out = new MiniBuffer(view.byteLength);
                        out.set(view);
                        return out;
                }
                if (Array.isArray(value)) { const out = new MiniBuffer(value.length); for (let i = 0; i < value.length; i++) out[i] = value[i] & 0xff; return out; }
                if (typeof value === 'number') return new MiniBuffer(value);
                throw new TypeError(`Buffer.from: unsupported value ${typeof value}`);
        }
        static alloc(size: number, fill: number | string = 0, encoding = 'utf8'): MiniBuffer {
                const out = new MiniBuffer(Math.max(0, size | 0));
                if (typeof fill === 'number') out.fill(fill & 0xff);
                else if (typeof fill === 'string') { const src = MiniBuffer.from(fill, encoding); if (src.length) for (let i = 0; i < out.length; i += src.length) out.set(src.subarray(0, out.length - i), i); }
                return out;
        }
        static allocUnsafe(size: number): MiniBuffer { return new MiniBuffer(Math.max(0, size | 0)); }
        static allocUnsafeSlow(size: number): MiniBuffer { return new MiniBuffer(Math.max(0, size | 0)); }
        static concat(list: ArrayLike<ArrayBufferView> | ArrayBufferView[], totalLength?: number): MiniBuffer {
                const items = list as ArrayBufferView[];
                const total = typeof totalLength === 'number' ? totalLength : items.reduce((n, v) => n + v.byteLength, 0);
                const out = new MiniBuffer(total);
                let off = 0;
                for (const v of items) { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); out.set(u, off); off += u.byteLength; }
                return out;
        }
        static isBuffer(x: unknown): x is MiniBuffer { return x instanceof MiniBuffer; }
        static byteLength(value: string, encoding = 'utf8'): number {
                const enc = encoding.toLowerCase();
                if (enc === 'base64') return decodeBase64(value).length;
                if (enc === 'hex') return decodeHex(value).length;
                if (enc === 'latin1' || enc === 'binary') return value.length;
                return encodeUtf8(value).length;
        }
        toString(encoding: string = 'utf8', start = 0, end = this.length): string {
                const enc = encoding.toLowerCase();
                if (enc === 'base64') return encodeBase64(this, start, end);
                if (enc === 'hex') return encodeHex(this, start, end);
                if (enc === 'latin1' || enc === 'binary') { let s = ''; const limit = Math.min(end, this.length); for (let i = start; i < limit; i++) s += String.fromCharCode(this[i]); return s; }
                return decodeUtf8(this, start, end);
        }
        write(string: string, offset = 0, length?: number, encoding = 'utf8'): number {
                const enc = encoding.toLowerCase();
                const bytes = enc === 'base64' ? decodeBase64(string) : enc === 'hex' ? decodeHex(string) : enc === 'latin1' || enc === 'binary' ? Array.from(string, (c) => c.charCodeAt(0)) : encodeUtf8(string);
                const len = Math.min(bytes.length, (length ?? bytes.length), this.length - offset);
                for (let i = 0; i < len; i++) this[offset + i] = bytes[i] & 0xff;
                return len;
        }
        fill(value: number | string, offset = 0, end = this.length, encoding = 'utf8'): this {
                const limit = Math.min(end, this.length);
                if (typeof value === 'number') { for (let i = offset; i < limit; i++) this[i] = value & 0xff; return this; }
                const src = MiniBuffer.from(value, encoding);
                if (src.length) for (let i = offset; i < limit; i += src.length) { const n = Math.min(src.length, limit - i); for (let j = 0; j < n; j++) this[i + j] = src[j]; }
                return this;
        }
        slice(start = 0, end = this.length): MiniBuffer {
                const s = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
                const e = end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length);
                const out = new MiniBuffer(Math.max(0, e - s));
                out.set(this.subarray(s, e));
                return out;
        }
        subarray(start?: number, end?: number): MiniBuffer {
                const u = Uint8Array.prototype.subarray.call(this, start, end);
                return Object.setPrototypeOf(u, MiniBuffer.prototype) as MiniBuffer;
        }
        toJSON(): { type: 'Buffer'; data: number[] } { return { type: 'Buffer', data: Array.from(this) }; }
        readUInt8(offset: number): number { return this[offset]; }
        readInt8(offset: number): number { const v = this[offset]; return v & 0x80 ? v - 0x100 : v; }
        readUInt16LE(offset: number): number { return this[offset] | (this[offset + 1] << 8); }
        readInt16LE(offset: number): number { const v = this.readUInt16LE(offset); return v & 0x8000 ? v - 0x10000 : v; }
        readUInt32LE(offset: number): number { return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24)) >>> 0; }
        readInt32LE(offset: number): number { return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24); }
        readUInt16BE(offset: number): number { return (this[offset] << 8) | this[offset + 1]; }
        readUInt32BE(offset: number): number { return (((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0); }
        writeUInt8(value: number, offset: number): number { this[offset] = value & 0xff; return offset + 1; }
        writeUInt16LE(value: number, offset: number): number { this[offset] = value & 0xff; this[offset + 1] = (value >> 8) & 0xff; return offset + 2; }
        writeInt16LE(value: number, offset: number): number { return this.writeUInt16LE(value & 0xffff, offset); }
        writeUInt32LE(value: number, offset: number): number { this[offset] = value & 0xff; this[offset + 1] = (value >> 8) & 0xff; this[offset + 2] = (value >> 16) & 0xff; this[offset + 3] = (value >> 24) & 0xff; return offset + 4; }
        writeInt32LE(value: number, offset: number): number { return this.writeUInt32LE(value >>> 0, offset); }
}

function pathNormalize(p: string): string {
        const isAbs = p.startsWith('/');
        const segs = p.split('/');
        const out: string[] = [];
        for (const s of segs) { if (!s || s === '.') continue; if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!isAbs) out.push('..'); continue; } out.push(s); }
        const joined = out.join('/');
        return (isAbs ? '/' : '') + joined + (joined === '' && !isAbs ? '.' : '') + (out.length && /\/$/.test(p) ? '/' : '');
}
function pathJoin(...parts: string[]): string {
        const segs: string[] = [];
        let abs = false;
        for (const part of parts) {
                const p = String(part ?? '');
                if (!p) continue;
                if (p.startsWith('/')) { segs.length = 0; abs = true; }
                for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') { if (segs.length && segs[segs.length - 1] !== '..') segs.pop(); continue; } segs.push(s); }
        }
        return (abs ? '/' : '') + (segs.join('/') || '.');
}
function pathResolve(...segments: string[]): string {
        let cwd = '/';
        const resolved = pathJoin(cwd, ...segments);
        return pathNormalize(resolved.startsWith('/') ? resolved : '/' + resolved);
}
function pathDirname(p: string): string {
        const norm = pathNormalize(p);
        const i = norm.lastIndexOf('/');
        if (i < 0) return '.';
        if (i === 0) return '/';
        return norm.slice(0, i);
}
function pathBasename(p: string, ext?: string): string {
        const norm = pathNormalize(p);
        const base = norm.slice(norm.lastIndexOf('/') + 1);
        if (ext && base.endsWith(ext) && base !== ext) return base.slice(0, base.length - ext.length);
        return base;
}
function pathExtname(p: string): string {
        const base = pathBasename(p);
        const i = base.lastIndexOf('.');
        if (i <= 0) return '';
        return base.slice(i);
}
function pathIsAbsolute(p: string): boolean { return String(p ?? '').startsWith('/'); }
function pathRelative(from: string, to: string): string {
        const a = pathNormalize(from).split('/').filter(Boolean);
        const b = pathNormalize(to).split('/').filter(Boolean);
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        const up = a.slice(i).map(() => '..');
        const down = b.slice(i);
        const rel = [...up, ...down].join('/');
        return rel || '.';
}
function pathParse(p: string): { root: string; dir: string; base: string; name: string; ext: string } {
        const norm = pathNormalize(p);
        const root = norm.startsWith('/') ? '/' : '';
        const dir = pathDirname(norm);
        const base = pathBasename(norm);
        const ext = pathExtname(base);
        const name = base.slice(0, base.length - ext.length);
        return { root, dir, base, name, ext };
}
function pathFormat(parts: { root?: string; dir?: string; base?: string; name?: string; ext?: string }): string {
        const dir = parts.dir ?? parts.root ?? '';
        const base = parts.base ?? (parts.name ?? '') + (parts.ext ?? '');
        return dir ? pathJoin(dir, base) : base;
}
const pathModule = {
        sep: '/', delimiter: '/', posix: null as any, win32: null as any,
        normalize: pathNormalize, join: pathJoin, resolve: pathResolve, relative: pathRelative,
        dirname: pathDirname, basename: pathBasename, extname: pathExtname, isAbsolute: pathIsAbsolute,
        parse: pathParse, format: pathFormat,
};
(pathModule as any).posix = pathModule;
(pathModule as any).win32 = pathModule;

class MiniEventEmitter {
        private _events: Record<string, Array<(arg?: any) => void> | ((arg?: any) => void) | undefined> = {};
        on(event: string, listener: (arg?: any) => void): this {
                const list = this._events[event] = (this._events[event] ? (Array.isArray(this._events[event]) ? [...(this._events[event] as any[])] : [this._events[event] as any]) : []) as any;
                list.push(listener);
                this._events[event] = list;
                return this;
        }
        addListener = MiniEventEmitter.prototype.on;
        once(event: string, listener: (arg?: any) => void): this { const wrap = (arg?: any) => { this.off(event, wrap); listener(arg); }; return this.on(event, wrap); }
        off(event: string, listener: (arg?: any) => void): this {
                const list = this._events[event];
                if (!list) return this;
                if (Array.isArray(list)) { this._events[event] = list.filter((l) => l !== listener) as any; if (!(this._events[event] as any).length) delete this._events[event]; }
                else if (list === listener) delete this._events[event];
                return this;
        }
        removeListener = MiniEventEmitter.prototype.off;
        removeAllListeners(event?: string): this { if (event) delete this._events[event]; else this._events = {}; return this; }
        listeners(event: string): Array<(arg?: any) => void> { const l = this._events[event]; return Array.isArray(l) ? l : l ? [l] : []; }
        emit(event: string, ...args: any[]): boolean {
                const list = this._events[event];
                if (!list) return false;
                const arr = Array.isArray(list) ? list : [list];
                for (const l of [...arr]) { try { l(...args); } catch {} }
                return true;
        }
}


function makeFs(switchFs: SwitchFs | null, opts: NodeCompatOptions) {
        const { gameRoot } = opts;
        const overlayBase = overlayBaseFor(gameRoot);
        const mem = new Map<string, ArrayBuffer>();
        let overlayReady = false;

        const resolve = (raw: string): string => {
                const r = resolveFsPath(gameRoot, raw);
                if (r === null) { const e: any = new Error(`EPERM: path outside app root '${raw}'`); e.code = 'EPERM'; throw e; }
                return r;
        };
        const overlayPathFor = (resolved: string): string | null => {
                const rel = relFromAppRoot(gameRoot, resolved);
                if (rel === null) return null;
                return rel ? `${overlayBase}/${rel}` : overlayBase;
        };
        const ensureOverlay = (): void => {
                if (overlayReady || !switchFs) { overlayReady = true; return; }
                try { switchFs.mkdirSync?.(overlayBase); } catch {}
                overlayReady = true;
        };

        const text = (data: string | ArrayBuffer): ArrayBuffer => typeof data === 'string' ? new TextEncoder().encode(data).buffer : data;

        const stat = (resolved: string): { mode: number; size: number; mtime: Date; isDirectory(): boolean; isFile(): boolean } | null => {
                if (!switchFs) {
                        const buf = mem.get(resolved);
                        return buf ? { mode: S_IFREG, size: buf.byteLength, mtime: new Date(0), isDirectory: () => false, isFile: () => true } : null;
                }
                const overlay = overlayPathFor(resolved);
                if (overlay) {
                        try { const o = switchFs.statSync(overlay); if (o) return { mode: o.mode, size: 0, mtime: new Date(0), isDirectory: () => (o.mode & 0o170000) === S_IFDIR, isFile: () => (o.mode & 0o170000) === S_IFREG }; } catch {}
                }
                try { const r = switchFs.statSync(resolved); if (r) return { mode: r.mode, size: 0, mtime: new Date(0), isDirectory: () => (r.mode & 0o170000) === S_IFDIR, isFile: () => (r.mode & 0o170000) === S_IFREG }; } catch {}
                return null;
        };

        const fs = {
                existsSync(path: string): boolean { try { return stat(resolve(path)) !== null; } catch { return false; } },
                statSync(path: string): any { const s = stat(resolve(path)); if (!s) { const e: any = new Error(`ENOENT: no such file or directory, stat '${path}'`); e.code = 'ENOENT'; throw e; } return s; },
                lstatSync(path: string): any { return this.statSync(path); },
                readFileSync(path: string, options?: any): string | ArrayBuffer {
                        const wantString = typeof options === 'string' || (options && options.encoding);
                        const resolved = resolve(path);
                        let bytes: ArrayBuffer | null = null;
                        if (!switchFs) bytes = mem.get(resolved) ?? null;
                        else {
                                const overlay = overlayPathFor(resolved);
                                if (overlay) { try { bytes = switchFs.readFileSync(overlay); } catch { bytes = null; } }
                                if (bytes === null) { try { bytes = switchFs.readFileSync(resolved); } catch { bytes = null; } }
                        }
                        if (bytes === null) { const e: any = new Error(`ENOENT: no such file or directory, open '${path}'`); e.code = 'ENOENT'; throw e; }
                        return wantString ? new TextDecoder().decode(bytes) : bytes;
                },
                writeFileSync(path: string, data: string | ArrayBuffer): void {
                        const buf = text(data);
                        const resolved = resolve(path);
                        if (!switchFs) { mem.set(resolved, buf); return; }
                        ensureOverlay();
                        const overlay = overlayPathFor(resolved);
                        if (!overlay) { const e: any = new Error(`EPERM: path outside app root '${path}'`); e.code = 'EPERM'; throw e; }
                        try { const dir = pathDirname(overlay.replace(/^sdmc:\//i, '')); if (dir) switchFs.mkdirSync?.(`sdmc:/${dir}`); } catch {}
                        switchFs.writeFileSync(overlay, buf);
                },
                appendFileSync(path: string, data: string | ArrayBuffer): void {
                        let prev = '';
                        try { prev = this.readFileSync(path, 'utf8') as string; } catch {}
                        this.writeFileSync(path, prev + (typeof data === 'string' ? data : new TextDecoder().decode(data)));
                },
                unlinkSync(path: string): void {
                        const resolved = resolve(path);
                        if (!switchFs) { mem.delete(resolved); return; }
                        const overlay = overlayPathFor(resolved);
                        if (overlay) { try { (switchFs.removeSync || switchFs.unlinkSync)?.(overlay); } catch {} }
                },
                mkdirSync(path: string): void {
                        const resolved = resolve(path);
                        if (!switchFs) return;
                        ensureOverlay();
                        const overlay = overlayPathFor(resolved);
                        if (overlay) { try { switchFs.mkdirSync?.(overlay); } catch {} }
                },
                readdirSync(path: string): string[] {
                        const resolved = resolve(path);
                        if (!switchFs) return [];
                        const set = new Set<string>();
                        const real = switchFs.readDirSync?.(resolved);
                        if (real) for (const e of real) set.add(e);
                        const overlay = overlayPathFor(resolved);
                        if (overlay) { const ov = switchFs.readDirSync?.(overlay); if (ov) for (const e of ov) set.add(e); }
                        return [...set];
                },
                readFile(path: string, options: any, callback?: (err: Error | null, data?: any) => void): void {
                        const cb = typeof options === 'function' ? options : callback;
                        try { const data = this.readFileSync(path, options); nextMicrotask(() => cb?.(null, data)); }
                        catch (err) { nextMicrotask(() => cb?.(err as Error)); }
                },
                writeFile(path: string, data: any, options: any, callback?: (err: Error | null) => void): void {
                        const cb = typeof options === 'function' ? options : callback;
                        try { this.writeFileSync(path, data); nextMicrotask(() => cb?.(null)); }
                        catch (err) { nextMicrotask(() => cb?.(err as Error)); }
                },
                stat(path: string, callback: (err: Error | null, stats?: any) => void): void { try { const s = this.statSync(path); nextMicrotask(() => callback(null, s)); } catch (err) { nextMicrotask(() => callback(err as Error)); } },
                mkdir(path: string, options: any, callback?: (err: Error | null) => void): void { const cb = typeof options === 'function' ? options : callback; try { this.mkdirSync(path); nextMicrotask(() => cb?.(null)); } catch (err) { nextMicrotask(() => cb?.(err as Error)); } },
                unlink(path: string, callback: (err: Error | null) => void): void { try { this.unlinkSync(path); nextMicrotask(() => callback(null)); } catch (err) { nextMicrotask(() => callback(err as Error)); } },
                constants: { R_OK: 4, W_OK: 2, X_OK: 1, F_OK: 0 },
                promises: {
                        readFile: async (path: string, options?: any) => fs.readFileSync(path, options),
                        writeFile: async (path: string, data: any) => { fs.writeFileSync(path, data); },
                        stat: async (path: string) => fs.statSync(path),
                        mkdir: async (path: string) => { fs.mkdirSync(path); },
                        unlink: async (path: string) => { fs.unlinkSync(path); },
                        readdir: async (path: string) => fs.readdirSync(path),
                        exists: async (path: string) => fs.existsSync(path),
                },
        };
        return fs;
}

function stubModule(): any {
        const target: any = function () { return proxy; };
        let proxy: any;
        proxy = new Proxy(target, {
                get: () => proxy,
                apply: () => proxy,
                construct: () => proxy,
                has: () => true,
        });
        return proxy;
}

function makeProcess(appRoot: string, switchFs: SwitchFs | null, log?: (s: string) => void): any {
        const stream = { write: () => true, end() {}, on() { return this; } };
        const mainModule = { filename: `${appRoot}/www/index.html`, id: '.', path: `${appRoot}/www/index.html`, paths: [], children: [], loaded: true, exports: {} as any, require: null as any };
        return {
                platform: 'switch', arch: 'arm64', type: 'switch', release: { name: 'switch' },
                env: { ...((globalThis as any).process?.env ?? {}) } as Record<string, string>,
                argv: ['burialnx'],
                cwd: () => appRoot,
                chdir() {},
                exit: (code?: number) => { try { (globalThis as any).Switch?.exit?.(code ?? 0); } catch {} },
                on: () => ({} as any), once: () => ({} as any), off: () => ({} as any), emit: () => false,
                addListener: () => ({} as any), removeListener: () => ({} as any), removeAllListeners: () => ({} as any),
                nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => { nextMicrotask(() => fn(...args)); },
                setImmediate: (fn: (...a: unknown[]) => void, ...args: unknown[]) => setTimeout(() => fn(...args), 0),
                stdout: stream, stderr: stream, stdin: { on() { return this; }, pipe() { return this; } },
                version: 'v16.15.0', versions: { node: '16.15.0', v8: '9.4.146.19' },
                pid: 0, ppid: 0, hrtime: (time?: [number, number]): [number, number] => {
                        const now = performance.now() * 1e6;
                        const prev = time ? time[0] * 1e9 + time[1] : 0;
                        const delta = Math.max(0, now - prev);
                        return [Math.floor(delta / 1e9), Math.floor(delta % 1e9)] as [number, number];
                },
                uptime: () => performance.now() / 1000,
                memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
                browser: false, cwdPath: appRoot,
                mainModule, _mainModule: mainModule,
        };
}

function makeNw(appRoot: string, switchFs: SwitchFs | null, manifest: any, log?: (s: string) => void): any {
        const win: any = new MiniEventEmitter();
        Object.assign(win, {
                window: win, x: 0, y: 0, width: 1280, height: 720,
                title: manifest?.window?.title || 'Game',
                isFullscreen: false, isTransparent: false, isKioskMode: false,
                get() { return win; },
                show() {}, hide() {}, close() {}, restore() {}, minimize() {}, maximize() {},
                focus() {}, blur() {}, moveTo() {}, moveBy() {}, resizeTo() {}, resizeBy() {},
                setTransparent() {}, setKioskMode() {}, enterFullscreen() {}, leaveFullscreen() {},
                toggleFullscreen() {}, setMaximumSize() {}, setMinimumSize() {},
                setTitle(t: string) { win.title = t; }, getTitle: () => win.title,
                setIcon() {}, setBadgeLabel() {}, setProgressBar() {}, setShowInTaskbar() {},
                setPosition() {}, requestAttention() {}, capturePage: () => ({}), snapshot: () => Promise.resolve({}),
                eval(cb: () => void) { try { cb(); } catch (e) { log?.(`nw.Window.eval failed: ${String(e)}`); } },
                menu: null, setMenu() {},
                on: win.on.bind(win), once: win.once.bind(win), off: win.off.bind(win), removeListener: win.off.bind(win), emit: win.emit.bind(win),
        });
        const Shell = { openExternal(url: string) { log?.(`nw.Shell.openExternal ignored: ${url}`); }, openItem() { return false; }, showItemInFolder() { return false; } };
        const Clipboard = { get: () => '', set() {}, clear() {} };
        const App = new MiniEventEmitter();
        Object.assign(App, {
                manifest, argv: [], dataPath: appRoot, userAppDir: appRoot,
                quit() { try { (globalThis as any).Switch?.exit?.(0); } catch {} },
                closeAllWindows() { this.quit(); },
                setWindowOpenHandler() {}, getArgvSync: () => [], addEnv() {}, removeEnv() {},
                on: App.on.bind(App), once: App.once.bind(App), off: App.off.bind(App), emit: App.emit.bind(App),
        });
        const Screen = { init() {}, screens: [], chooseCurscreen() {} };
        const Tray = function () { return { setTooltip() {}, setIcon() {}, on() {}, remove() {} } };
        const Menu = function () { return { append() {}, insert() {}, remove() {}, popup() {}, items: [] } };
        const MenuItem = function (opts: any) { return opts };
        const nw: any = {
                Window: win, App, Shell, Clipboard, Screen, Tray, Menu, MenuItem,
                require: (id: string) => (id === 'nw.gui' || id === 'nw') ? nw : undefined,
        };
        nw.gui = nw;
        return nw;
}

export interface NodeCompatRuntime {
        require: ((id: string) => any) & { cache?: Map<string, any>; resolve?: (id: string) => string };
        process: any;
        Buffer: typeof MiniBuffer;
        module: { exports: any; id: string; filename: string; loaded: boolean; children: any[]; paths: string[]; require?: (id: string) => any };
        exports: any;
        global: any;
        __dirname: string;
        __filename: string;
        nw: any;
}

/** Install Node/NW.js compatibility globals on the runtime, preserving any already present. */
export function installNodeCompat(runtime: any, switchFs: SwitchFs | null, opts: NodeCompatOptions): NodeCompatRuntime {
        const { gameRoot, log } = opts;
        const appRoot = appRootFrom(gameRoot);

        const fs = makeFs(switchFs, opts);
        const moduleCache = new Map<string, { exports: any }>();
        const builtins = new Map<string, any>();

        const register = (id: string, mod: any) => { builtins.set(id, mod); };
        register('fs', fs);
        register('path', pathModule);
        register('buffer', { Buffer: MiniBuffer, SlowBuffer: MiniBuffer, kMaxLength: 0x7fffffff });
        register('events', { EventEmitter: MiniEventEmitter, default: MiniEventEmitter, once: (e: MiniEventEmitter, n: string) => new Promise<void>((r) => e.once(n, () => r())) });
        register('util', {
                inspect: (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v),
                format: (f: unknown, ...a: unknown[]) => typeof f === 'string' ? f.replace(/%[sdjifoO%]/g, (m) => m === '%%' ? '%' : String(a.shift() ?? '')) : [f, ...a].map(String).join(' '),
                isArray: Array.isArray, isString: (v: unknown) => typeof v === 'string', isNumber: (v: unknown) => typeof v === 'number',
                isFunction: (v: unknown) => typeof v === 'function', isObject: (v: unknown) => typeof v === 'object' && v !== null,
                isNull: (v: unknown) => v === null, isUndefined: (v: unknown) => v === undefined, isBuffer: (v: unknown) => v instanceof MiniBuffer,
                inherit: (ctor: any, superCtor: any) => { if (ctor && superCtor) ctor.prototype = Object.create(superCtor.prototype); },
                types: { isPromise: (v: unknown) => v instanceof Promise },
                promisify: (fn: Function) => (...args: unknown[]) => new Promise((res, rej) => fn(...args, (e: unknown, v: unknown) => e ? rej(e) : res(v))),
                TextEncoder: (globalThis as any).TextEncoder, TextDecoder: (globalThis as any).TextDecoder, callbackify: (fn: Function) => fn,
        });
        register('url', {
                parse: (str: string) => { try { return new URL(str, `file://${appRoot}/`); } catch { return { href: str, pathname: str }; } },
                format: (u: URL | Record<string, unknown>) => u instanceof URL ? u.href : String((u as any).href ?? ''),
                resolve: (from: string, to: string) => { try { return new URL(to, new URL(from, `file://${appRoot}/`)).href; } catch { return to; } },
                fileURLToPath: (u: string | URL) => (u instanceof URL ? u : new URL(u)).pathname,
                pathToFileURL: (p: string) => new URL(`file://${p}`),
                URLSearchParams: (globalThis as any).URLSearchParams, URL: (globalThis as any).URL,
        });
        register('querystring', {
                parse: (str: string) => { const o: Record<string, string> = {}; for (const pair of String(str).split('&')) { if (!pair) continue; const i = pair.indexOf('='); const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i)); const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1)); o[k] = v; } return o; },
                stringify: (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
                escape: encodeURIComponent, unescape: decodeURIComponent,
        });
        register('os', {
                platform: () => 'switch', arch: () => 'arm64', type: () => 'Switch', release: () => '1.0', hostname: () => 'switch',
                homedir: () => appRoot, tmpdir: () => 'sdmc:/switch/burialnx/tmp', cpus: () => [], endianness: () => 'LE',
                networkInterfaces: () => ({}), userInfo: () => ({ username: 'switch', homedir: appRoot, shell: '' }),
                totalmem: () => 0, freemem: () => 0, uptime: () => 0, constants: {}, EOL: '\n',
        });
        register('crypto', {
                createHash: (alg: string) => { let data = ''; return { update(d: any) { data += typeof d === 'string' ? d : new TextDecoder().decode(d); return this; }, digest(enc?: string) { const h = simpleHash(data, alg); return enc ? MiniBuffer.from(h, 'hex').toString(enc) : MiniBuffer.from(h, 'hex'); } }; },
                randomBytes: (n: number, cb?: (e: Error | null, b?: MiniBuffer) => void) => { const b = MiniBuffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0; if (cb) nextMicrotask(() => cb(null, b)); return b; },
                pseudoRandomBytes(n: number, cb?: (e: Error | null, b?: MiniBuffer) => void) { return this.randomBytes(n, cb as any); },
                createHmac: () => ({ update() { return this; }, digest: () => MiniBuffer.alloc(0) }),
                randomInt: (min: number, max: number) => Math.floor(Math.random() * (max - min)) + min,
        });
        register('zlib', {
                deflateSync: (b: ArrayBuffer) => b, inflateSync: (b: ArrayBuffer) => b, gzipSync: (b: ArrayBuffer) => b, gunzipSync: (b: ArrayBuffer) => b,
                deflate: (b: ArrayBuffer, cb: (e: Error | null, r?: ArrayBuffer) => void) => nextMicrotask(() => cb(null, b)),
                inflate: (b: ArrayBuffer, cb: (e: Error | null, r?: ArrayBuffer) => void) => nextMicrotask(() => cb(null, b)),
                createDeflate: () => stubStream(), createInflate: () => stubStream(), createGzip: () => stubStream(), createGunzip: () => stubStream(),
                constants: { Z_NO_FLUSH: 0 },
        });
        register('child_process', {
                exec: () => {}, execSync: () => '', spawn: () => ({ on() { return this; }, stdout: stubStream(), stderr: stubStream(), stdin: stubStream(), kill() {}, pid: 0 }), spawnSync: () => ({ pid: 0, status: 0, stdout: '', stderr: '' }), fork: () => ({ on() { return this; }, send() {}, kill() {} }),
        });
        register('stream', { Stream: stubStreamCtor, Readable: stubStreamCtor, Writable: stubStreamCtor, Duplex: stubStreamCtor, Transform: stubStreamCtor, PassThrough: stubStreamCtor, pipeline: () => {}, finished: () => {} });
        register('net', stubModule());
        register('tls', stubModule());
        register('http', { request: () => stubStream(), get: () => stubStream(), Server: stubStreamCtor, createServer: () => stubStream(), METHODS: [], STATUS_CODES: {} });
        register('https', { request: () => stubStream(), get: () => stubStream(), Server: stubStreamCtor, createServer: () => stubStream(), METHODS: [], STATUS_CODES: {} });
        register('timers', { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (fn: () => void) => setTimeout(fn, 0), clearImmediate: (id: any) => clearTimeout(id) });
        register('assert', { ok: (v: unknown) => { if (!v) throw new Error('Assertion failed'); }, equal: (a: unknown, b: unknown) => { if (a !== b) throw new Error('Assertion failed'); }, notEqual: () => {}, fail: (m?: string) => { throw new Error(m || 'fail'); } });
        register('string_decoder', { StringDecoder: class { write(s: any) { return typeof s === 'string' ? s : new TextDecoder().decode(s); } end(s: any) { return s ? this.write(s) : ''; } } });

        const manifest = readManifest(fs, appRoot);
        const processObj = makeProcess(appRoot, switchFs, log);
        const nwObj = makeNw(appRoot, switchFs, manifest, log);
        register('nw.gui', nwObj);
        register('nw', nwObj);

        function requireRelative(id: string, fromDir: string): any {
                const candidates = [id, `${id}.js`, `${id}.json`, `${id}/index.js`, `${id}/index.json`];
                const bases = [fromDir, `${appRoot}/www`, appRoot];
                for (const base of bases) {
                        const baseRel = base.replace(/^sdmc:\//i, '');
                        for (const c of candidates) {
                                const rel = pathNormalize(`/${baseRel}/${c}`).replace(/^\//, '');
                                const full = `sdmc:/${rel}`;
                                if (fs.existsSync(full)) {
                                        if (moduleCache.has(full)) return moduleCache.get(full)!.exports;
                                        const m = { exports: {} as any };
                                        moduleCache.set(full, m);
                                        try {
                                                const src = fs.readFileSync(full, 'utf8') as string;
                                                const dir = pathDirname(rel);
                                                const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', 'process', 'Buffer', 'global', 'nw', src + '\n//# sourceURL=' + full);
                                                fn(m, m.exports, makeRequire(`sdmc:/${dir}`), dir, full, processObj, MiniBuffer, runtime, nwObj);
                                        } catch (e) { log?.(`node-compat: require('${id}') failed: ${e instanceof Error ? e.message : String(e)}`); }
                                        return m.exports;
                                }
                        }
                }
                log?.(`node-compat: module not found '${id}' (from ${fromDir}) — returning stub`);
                return stubModule();
        }

        function makeRequire(fromDir: string): ((id: string) => any) & { cache: Map<string, any>; resolve: (id: string) => string } {
                const req: any = (id: string) => {
                        if (typeof id !== 'string' || !id) return stubModule();
                        if (builtins.has(id)) return builtins.get(id);
                        // Relative (./ ../), absolute (/), or Windows-drive-relative require.
                        if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/') || /^[a-z]:[\\/]/i.test(id)) {
                                const rel = /^[a-z]:[\\/]/i.test(id) ? id.slice(2).replace(/\\/g, '/') : id;
                                return requireRelative(rel.startsWith('/') ? '.' + rel : rel, fromDir);
                        }
                        // Bare unknown module (e.g. an npm package the game expects): stub.
                        log?.(`node-compat: unknown module '${id}' — returning stub`);
                        return stubModule();
                };
                req.cache = moduleCache;
                req.resolve = (id: string) => id;
                return req;
        }

        const rootRequire = makeRequire(appRoot);

        const g = runtime;
        if (typeof g.require === 'undefined') g.require = rootRequire;
        if (typeof g.process === 'undefined') g.process = processObj;
        if (typeof g.Buffer === 'undefined') g.Buffer = MiniBuffer;
        if (typeof g.module === 'undefined') g.module = { exports: {}, id: '<main>', filename: `${appRoot}/index.html`, loaded: true, children: [], paths: [], require: rootRequire };
        if (typeof g.exports === 'undefined') g.exports = g.module.exports;
        if (typeof g.global === 'undefined') g.global = runtime;
        if (typeof g.__dirname === 'undefined') g.__dirname = appRoot;
        if (typeof g.__filename === 'undefined') g.__filename = `${appRoot}/index.html`;
        if (typeof g.nw === 'undefined') g.nw = nwObj;
        if (typeof g.globalThis === 'undefined') g.globalThis = runtime;
        // Reflect that `module.exports` and `exports` should follow each other.
        g.module.exports = g.exports;

        return { require: rootRequire, process: processObj, Buffer: MiniBuffer, module: g.module, exports: g.exports, global: runtime, __dirname: appRoot, __filename: `${appRoot}/index.html`, nw: nwObj };
}

function stubStreamCtor(): any {
        function Ctor() { return Object.assign(new MiniEventEmitter(), { write() { return this; }, end() { return this; }, pipe() { return this; }, on() { return this; }, read() { return null; }, destroy() {} }); }
        return Ctor;
}
function stubStream(): any { return stubStreamCtor()(); }

function simpleHash(data: string, alg: string): string {
        let h = 0x811c9dc5;
        for (let i = 0; i < data.length; i++) { h ^= data.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        let out = (h >>> 0).toString(16).padStart(8, '0');
        while (out.length < 32) out += out;
        return out.slice(0, 32);
}

function readManifest(fs: any, appRoot: string): any {
        try { const txt = fs.readFileSync(`${appRoot}/package.json`, 'utf8'); return JSON.parse(txt); } catch { return { main: 'www/index.html', window: { title: 'Game' } }; }
}
