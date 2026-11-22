import { viewport } from './runtime-plan';
import type { MovieResolver, MovieSource } from './video-source';

export interface VideoBackend extends EventTarget {
        src: string; readyState: number; readonly videoWidth: number; readonly videoHeight: number;
        currentTime: number; readonly duration: number; readonly paused: boolean; readonly ended: boolean;
        readonly seeking?: boolean; volume: number; muted: boolean; loop: boolean;
        play(): Promise<void>; pause(): void; close?(): void; playbackRate?: number;
        getVideoPlaybackQuality?(): {totalVideoFrames: number; droppedVideoFrames: number};
}
type NativeCtor = new () => VideoBackend;
type SourceChild = EventTarget & {tagName:string; src?:string; type?:string; getAttribute?(name:string):string|null};
type SourceOption = {url:string; mime?:string; child?:SourceChild};
type ElementBase = new (...args: any[]) => EventTarget & { parentNode: any; children?:ArrayLike<SourceChild>; style: Record<string,string>; attributes: Record<string,string> };
const forwarded = ['loadedmetadata','loadeddata','canplay','canplaythrough','play','playing','pause','timeupdate','seeking','seeked','ended','error'] as const;
const abort = () => Object.assign(new Error('Movie request was superseded or paused'), {name:'AbortError'});

/** beta.7 exposes videoClose only via its own synchronous constructor-installed unload listener.
 * Capture that listener during construction; NEVER dispatch a global unload. Without this, each
 * cutscene retains the decoder, its worker, audio ring and an unload closure until process exit. */
function openBackend(Ctor: NativeCtor, audio: boolean) {
        const g = globalThis as any, old = g.addEventListener;
        const hooks: {cb: EventListenerOrEventListenerObject; options: any}[] = [];
        const tap = function(this: any, name: string, cb: EventListenerOrEventListenerObject, opts?: unknown) {
                old.call(g, name, cb, opts);
                if (name === 'unload' && cb) hooks.push({cb,options:opts});
        };
        const intercept = !audio && typeof old === 'function' && typeof g.removeEventListener === 'function' && !Ctor.prototype.close;
        if (intercept) { try { g.addEventListener = tap; } catch { /* optional on alternate hosts */ } }
        let player: VideoBackend;
        try { player = new Ctor(); }
        finally { if (g.addEventListener === tap) g.addEventListener = old; }
        return { player, close() {
                try { player.pause(); } catch { /* already stopped */ }
                if (typeof player.close === 'function') { player.close(); return; }
                for (const {cb,options} of hooks.splice(0)) {
                        g.removeEventListener('unload', cb, options);
                        if (typeof cb === 'function') cb.call(g, new Event('unload'));
                        else cb.handleEvent(new Event('unload'));
                }
        } };
}

export function movieCanPlayType(mime: string, hasDecoder: boolean): ''|'maybe'|'probably' {
        if (!hasDecoder) return '';
        const [kind, ...params] = String(mime).trim().toLowerCase().split(';');
        const webm = kind.trim() === 'video/webm';
        if (!webm && !['video/mp4','video/x-m4v'].includes(kind.trim())) return '';
        const codecs = /(?:^|;)\s*codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/.exec(params.join(';'));
        if (!codecs) return 'maybe';
        const supported = webm ? /^(?:vp8|vp9|vp08|vp09|av01|vorbis|opus)(?:\.|$)/ : /^(?:avc1|avc3|h264|mp4a|hvc1|hev1|av01|mp4v)(?:\.|$)/;
        return (codecs[1] ?? codecs[2] ?? codecs[3]).split(',').every(c => supported.test(c.trim())) ? 'probably' : '';
}

/** MIME queries are advisory; completion is reported only after the native decoder succeeds. */
export function audioCanPlayType(mime:string,hasDecoder:boolean): ''|'maybe'|'probably' {
        if (!hasDecoder) return '';
        const [type,...rest]=String(mime).trim().toLowerCase().split(';');
        const formats: Record<string,RegExp>={
                'audio/ogg':/^(?:opus|vorbis|flac)$/,'audio/webm':/^(?:opus|vorbis)$/,
                'audio/mp4':/^(?:mp4a(?:\.[0-9a-f]+)*|aac|alac|flac|opus)$/,
                'audio/aac':/^(?:aac|mp4a(?:\.[0-9a-f]+)*)$/,'audio/mpeg':/^(?:mp3|mp2|mp1)$/,
                'audio/wav':/^(?:1|pcm|pcm_s16le|pcm_f32le)$/,'audio/flac':/^flac$/
        };
        const alias: Record<string,string>={'audio/x-m4a':'audio/mp4','audio/m4a':'audio/mp4','audio/wave':'audio/wav','audio/x-wav':'audio/wav','audio/x-flac':'audio/flac','audio/mp3':'audio/mpeg','audio/opus':'audio/ogg'};
        const re=formats[alias[type.trim()] || type.trim()];if (!(re instanceof RegExp)) return '';
        const codecs=/(?:^|;)\s*codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/.exec(rest.join(';'));
        if (!codecs) return 'maybe';
        return (codecs[1]??codecs[2]??codecs[3]??'').split(',').every(v=>re.test(v.trim()))?'probably':'';
}

// Both media types use the DOM state machine below. Video uses streaming Video;
// audio uses the captured native Audio (FFmpeg decode + Web Audio buffer source).
export function createMovieLayer<B extends ElementBase>(Base: B, resolve: MovieResolver, Ctor: NativeCtor | undefined, log: (s: string) => void, body: () => any, audio = false) {
        const live = new Set<MovieNode>();
        // One-shot voices must not retain their decoded PCM until the end of a game.
        // A playing native source keeps its callbacks alive. Keep only weak references
        // for host pause/dispose and prune dead entries periodically (without a GC hook).
        const voices = new Set<WeakRef<MovieNode>>(); let opens=0;
        let retired = false, suspended = false;
        function members(): MovieNode[] {const all=[...live];for(const ref of voices){const v=ref.deref();if(v)all.push(v);else voices.delete(ref);}return all;}
        class MovieNode extends Base {
                static readonly HAVE_NOTHING=0; static readonly HAVE_METADATA=1; static readonly HAVE_CURRENT_DATA=2; static readonly HAVE_FUTURE_DATA=3; static readonly HAVE_ENOUGH_DATA=4;
                readonly HAVE_NOTHING=0; readonly HAVE_METADATA=1; readonly HAVE_CURRENT_DATA=2; readonly HAVE_FUTURE_DATA=3; readonly HAVE_ENOUGH_DATA=4;
                width = 0; height = 0; autoplay = false; controls = false; preload = 'auto'; playsInline = true; hidden = false;
                error: {code:number; message:string} | null = null;
                private path = ''; private serial = 0; private control = 0; private firstFrame = false;
                private selected = ''; private offerKey = ''; private scheduled = false;
                private candidate?: {ok:()=>void; no:(e:unknown)=>void; failed:boolean};
                private resource?: MovieSource; private session?: ReturnType<typeof openBackend>;
                private task?: Promise<VideoBackend>; private listeners = new Map<string,EventListener>();
                private startupProbe?: ReturnType<typeof setTimeout>;
                private didPlay = false; private canPlayFired = false; private resumeAfterMenu = false;
                private gates: {open:()=>void; cancel:()=>void}[] = [];
                private weak?: WeakRef<MovieNode>;
                private pendingVoiceStarts=new Set<(reason:Error)=>void>();
                private speed=1; private gain = 1; private silent = false; private repeat = false; private seekTo: number | undefined;
                constructor(..._args: any[]) {
                        super(audio?'AUDIO':'VIDEO');
                        // Neither the nx.js EventTarget nor Node's EventTarget calls DOM property handlers.
                        for (const name of [...forwarded,'loadstart','volumechange']) this.addEventListener(name, e => {
                                const handler = (this as any)['on'+name]; if (typeof handler === 'function') handler.call(this, e);
                        });
                        if (audio && _args[0] != null && _args[0]!=='') this.src=String(_args[0]);
                }
                get src() { return this.path; }
                set src(value: string) { this.stop(); this.path = String(value ?? ''); this.attributes.src=this.path; if (this.path) this.start(); }
                get currentSrc() { return this.selected || this.path; }
                private explicit() { return Object.prototype.hasOwnProperty.call(this.attributes,'src'); }
                private offers(): SourceOption[] {
                        if (this.explicit()) return this.path ? [{url:this.path}] : [];
                        const choices:SourceOption[]=[];
                        for (const child of Array.from(this.children || [])) {
                                if (child.tagName !== 'SOURCE') continue;
                                const url=String(child.src || child.getAttribute?.('src') || '').trim();
                                let mime=String(child.type || child.getAttribute?.('type') || '').trim();
                                // Pixi 4 infers 'video/mp4?v=1' from the raw URL suffix. Strip
                                // its query/fragment only when it is exactly that inferred MIME.
                                if (mime===(audio?'audio/':'video/')+url.slice(url.lastIndexOf('.')+1)) mime=mime.split(/[?#]/,1)[0];
                                if (url && (!mime || this.canPlayType(mime))) choices.push({url,mime,child});
                        }
                        return choices;
                }
                private hasInput() {
                        return this.explicit() ? !!this.path : Array.from(this.children || []).some(c=>c.tagName==='SOURCE');
                }
                // Adding a <source> schedules selection, but Pixi appends all alternative
                // sources and calls load() synchronously. Coalesce those operations.
                sourcesChanged() {
                        if (this.explicit() || (this.task && !this.error) || this.scheduled || retired) return;
                        this.scheduled=true;
                        void Promise.resolve().then(()=>{
                                this.scheduled=false;
                                if (!retired && !this.explicit() && (!this.task || this.error) && this.hasInput()) this.load();
                        });
                }
                get readyState() { return Math.max(this.canPlayFired ? 3 : this.firstFrame ? 2 : 0,this.session?.player.readyState ?? 0); }
                get paused() { return this.session?.player.paused ?? true; }
                get ended() { return this.session?.player.ended ?? false; }
                get seeking() { return this.session?.player.seeking ?? false; }
                get videoWidth() { return this.session?.player.videoWidth ?? 0; }
                get videoHeight() { return this.session?.player.videoHeight ?? 0; }
                get duration() { return this.session?.player.duration ?? NaN; }
                get currentTime() { return this.seekTo ?? this.session?.player.currentTime ?? 0; }
                set currentTime(t: number) { if (!Number.isFinite(+t)) return; const s=Math.max(0,+t); if (this.readyState > 0) this.session!.player.currentTime=s; else this.seekTo=s; }
                get loop() { return this.repeat; }
                set loop(v: boolean) { this.repeat=!!v; if(this.session) this.session.player.loop=this.repeat; }
                get volume() { return this.gain; }
                set volume(v: number) { if (!Number.isFinite(+v)) return; this.gain=Math.max(0,Math.min(1,+v)); if(this.session) this.applyVolume(this.session.player); this.emit('volumechange'); }
                get muted() { return this.silent; }
                set muted(v: boolean) { this.silent=!!v; if(this.session) this.applyVolume(this.session.player); this.emit('volumechange'); }
                private applyVolume(p:VideoBackend){if(audio){p.volume=this.silent?0:this.gain;}else{p.volume=this.gain;p.muted=this.silent;}}
                get playbackRate() { return audio ? this.speed : 1; }
                set playbackRate(v: number) {
                        if(!audio && +v!==1)throw new Error('This native movie decoder supports 1x playback');
                        if(!Number.isFinite(+v)||+v<=0)throw new RangeError('Positive finite playbackRate required');
                        this.speed=+v;if(audio&&this.session)this.session.player.playbackRate=this.speed;
                }
                setAttribute(name: string, value: string) { name=String(name).toLowerCase(); this.attributes[name]=String(value); if (name==='src') this.src=value; else if(name==='muted') this.muted=true; else if(name==='loop') this.loop=true; else if(name==='autoplay') this.autoplay=true; }
                removeAttribute(name: string) { name=String(name).toLowerCase(); delete this.attributes[name]; if(name==='src') { this.stop(); this.path=''; this.sourcesChanged(); } else if(name==='muted') this.muted=false; else if(name==='loop') this.loop=false; else if(name==='autoplay') this.autoplay=false; }
                canPlayType(type: string) { return (audio?audioCanPlayType:movieCanPlayType)(type, typeof Ctor === 'function'); }
                getVideoPlaybackQuality() { return this.session?.player.getVideoPlaybackQuality?.() ?? {totalVideoFrames:0,droppedVideoFrames:0}; }
                private emit(name: string) { this.dispatchEvent(new Event(name)); }
                private clearProbe() { if(this.startupProbe!==undefined) clearTimeout(this.startupProbe); this.startupProbe=undefined; }
                private playing() {
                        if (!this.didPlay && this.firstFrame && this.session && !this.session.player.paused && !this.error) {
                                this.didPlay=true; this.emit('playing');
                        }
                }
                private ready(player: VideoBackend, id: number) {
                        if (this.firstFrame || this.error || this.serial!==id) return;
                        this.clearProbe(); this.firstFrame=true; this.candidate?.ok();
                        // Native Audio already owns the decoded samples at canplaythrough.
                        // Drop only our Blob URL, never a caller-owned URL or the native buffer.
                        if(audio){this.resource?.release();this.resource=undefined;}
                        this.emit('loadeddata');
                        if(this.serial!==id) return;
                        this.playing();
                        if (this.autoplay && player.paused) void this.play().catch(()=>{});
                }
                private watchFirstFrame(player: VideoBackend, id: number) {
                        this.clearProbe(); const deadline=Date.now()+45_000;
                        const check=()=>{
                                if(this.serial!==id || this.firstFrame || this.error) return;
                                const q=player.getVideoPlaybackQuality?.();
                                // The native canplay heuristic normally requires two queued frames.
                                // A very short clip can already have a drawable frame without ever
                                // meeting that threshold. Only trust actual presentation counters.
                                if(q && q.totalVideoFrames>q.droppedVideoFrames) {
                                        const shortChild=!!this.candidate && player.duration>0 && player.duration<=0.5;
                                        this.ready(player,id);
                                        // Pixi waits for canplay rather than loadeddata. A short clip
                                        // can be entirely drawable without reaching the two-frame queue.
                                        if(shortChild && id===this.serial && !this.error) this.canPlay();
                                        return;
                                }
                                if(Date.now()>=deadline) { this.attemptError('No decodable video frame within 45 seconds'); return; }
                                this.startupProbe=setTimeout(check,50);
                        };
                        this.startupProbe=setTimeout(check,50);
                }
                private fail(reason: unknown) {
                        if (this.error) return;
                        const message=reason instanceof Error ? reason.message : String(reason ?? 'Movie decoder error');
                        this.error={code:4,message}; this.firstFrame=false; this.clearProbe();
                        try { this.session?.player.pause(); } catch { /* preserve original error */ }
                        if(audio)log(`Audio failed: ${this.currentSrc || '(source list)'}: ${message}`);else log(`Movie failed: ${this.currentSrc || '(source list)'}: ${message}`); this.emit('error');
                }
                private canPlay() { if(!this.canPlayFired){this.canPlayFired=true; this.emit('canplay');} }
                private attemptError(e: unknown) {
                        // Before any drawable frame, a rejected child is not a terminal movie
                        // error. Once playback has started, never switch sources mid-scene.
                        const wait=this.candidate;
                        if (wait && !this.firstFrame) {
                                if (!wait.failed) { wait.failed=true; this.clearProbe(); wait.no(e); }
                        } else this.fail(e);
                }
                private dropBackend() {
                        this.clearProbe(); this.candidate?.no(abort()); this.candidate=undefined;
                        const s=this.session; this.session=undefined;
                        if(s) {
                                for (const [name,cb] of this.listeners) s.player.removeEventListener(name,cb);
                                try { s.close(); } catch(e) { log(`Movie cleanup: ${String(e)}`); }
                        }
                        this.listeners.clear(); this.resource?.release(); this.resource=undefined;
                }
                private async openOne(option:SourceOption,id:number):Promise<VideoBackend> {
                        if (typeof Ctor!=='function') throw new Error(audio?'Native nx.js Audio decoder is unavailable in this NRO':'Native nx.js Video decoder is unavailable in this NRO');
                        const path=option.url;
                        // An explicit <source> list owns the ordering. Do not let the normal
                        // MV single-src extension fallback steal a later candidate's turn.
                        const resource=await resolve(path,audio||!!option.child,option.mime);
                        if (id!==this.serial) {resource.release();throw abort();}
                        this.resource=resource;this.session=openBackend(Ctor,audio);
                        const player=this.session.player;this.applyVolume(player);player.loop=this.repeat;if(audio)player.playbackRate=this.speed;
                        const usable=(option.child||audio) ? new Promise<void>((ok,no)=>{this.candidate={ok,no,failed:false};}) : undefined;
                        if(usable) void usable.catch(()=>{}); // native src assignment itself can throw
                        for (const name of forwarded) {
                                const listener: EventListener=(event:any) => {
                                        if (id!==this.serial || this.session?.player!==player || this.error || this.candidate?.failed) return;
                                        if(name==='error') { this.attemptError(event.error || player['error' as keyof VideoBackend] || 'Invalid/unsupported movie'); return; }
                                        if(name==='loadedmetadata') {
                                                if(audio){
                                                        if(!(player.duration>0&&Number.isFinite(player.duration))){this.attemptError('No decodable audio samples');return;}
                                                        log(`Audio metadata: ${path}, ${player.duration}s`);
                                                }else{
                                                        if(!(player.videoWidth>0 && player.videoHeight>0)) { this.attemptError('Source has no decodable video track'); return; }
                                                        log(`Movie metadata: ${path}, ${player.videoWidth}x${player.videoHeight}, ${player.duration}s`);
                                                        this.watchFirstFrame(player,id);
                                                }
                                        }
                                        if(name==='ended' || name==='pause') this.didPlay=false;
                                        if(name==='ended'&&audio)log(`Audio ended: ${path}`);
                                        if(name==='ended'&&!audio) {
                                                const q=player.getVideoPlaybackQuality?.(); log(`Movie ended: ${path}, ${q?.totalVideoFrames ?? '?'} frames, ${q?.droppedVideoFrames ?? '?'} dropped`);
                                        }
                                        if(name==='playing') { this.playing(); return; }
                                        if(name==='loadedmetadata' && this.seekTo!==undefined) { const t=this.seekTo; this.seekTo=undefined; player.currentTime=t; }
                                        // beta.7 reports canplay, but not loadeddata. MV waits specifically
                                        // for loadeddata before play() and before revealing the movie layer.
                                        if (name==='loadeddata' || name==='canplay' || name==='canplaythrough') {
                                                this.ready(player,id);
                                                if(name==='loadeddata' || id!==this.serial) return;
                                                if(name==='canplay'){this.canPlay();return;}
                                                if(audio&&name==='canplaythrough'){this.canPlay();if(id!==this.serial)return;}
                                        }
                                        this.emit(name);
                                };
                                player.addEventListener(name,listener); this.listeners.set(name,listener);
                        }
                        // src already initiates native load. Keep child selection pending until
                        // first data: asynchronous native decode errors must try the next file.
                        if(audio){this.startupProbe=setTimeout(()=>{if(id===this.serial&&!this.firstFrame)this.attemptError('Audio decode timed out');},45000);}
                        player.src=resource.url;
                        if(usable) await usable;
                        if(id!==this.serial) throw abort();
                        this.candidate=undefined;
                        return player;
                }
                private start(options=this.offers()) {
                        const id=this.serial;
                        if (retired || !this.hasInput()) return;
                        this.offerKey=JSON.stringify(options.map(o=>[o.url,o.mime]));
                        if(audio&&typeof WeakRef==='function'){if(!this.weak){this.weak=new WeakRef(this);voices.add(this.weak);}if(++opens%32===0)members();}
                        else live.add(this);
                        const task=Promise.resolve().then(async()=>{
                                if(id!==this.serial) throw abort();
                                this.emit('loadstart');
                                let last:unknown = new Error('No supported local movie source');
                                const seen=new Map<SourceChild | undefined, Set<string>>();
                                // Reread children after each failure: a source error handler can
                                // remove or replace the next option, or append a new one.
                                for (let attempt=0;attempt<128;attempt++) {
                                        const option=this.offers().find(o=>!seen.get(o.child)?.has(JSON.stringify([o.url,o.mime])));
                                        if(!option)break;
                                        if(!seen.has(option.child))seen.set(option.child,new Set());
                                        seen.get(option.child)!.add(JSON.stringify([option.url,option.mime]));
                                        if(id!==this.serial) throw abort();
                                        this.selected=option.url;
                                        try { return await this.openOne(option,id); }
                                        catch(e) {
                                                if(id!==this.serial) throw abort();
                                                last=e;this.dropBackend();
                                                if(!option.child) throw e;
                                                log(`Movie source rejected: ${option.url}: ${String(e)}`);
                                                option.child.dispatchEvent(new Event('error'));
                                        }
                                }
                                throw last;
                        }).catch(e=>{if(id===this.serial)this.fail(e);throw e;});
                        this.task=task;void task.catch(()=>{});
                }
                load() {
                        if(retired)return;
                        if(!this.hasInput()){this.stop();return;}
                        const options=this.offers();
                        if(this.task && !this.error && !this.firstFrame && this.offerKey===JSON.stringify(options.map(o=>[o.url,o.mime])))return;
                        this.stop();this.start(options);
                }
                play(): Promise<void> {
                        if (!this.task && this.hasInput()) this.start();
                        const id=this.serial, command=this.control;
                        const p=(async()=>{
                                if (!this.task || this.error) throw new Error(this.error?.message || (audio?'No audio source':'No movie source'));
                                if(retired)throw abort();
                                let cancel:((e:Error)=>void)|undefined;
                                const player=audio?await Promise.race([this.task,new Promise<never>((_,no)=>{cancel=no;this.pendingVoiceStarts.add(no);})]).finally(()=>{if(cancel)this.pendingVoiceStarts.delete(cancel);}):await this.task;
                                if (id!==this.serial || command!==this.control) throw abort();
                                if(suspended) await new Promise<void>((ok,no)=>this.gates.push({open:ok,cancel:()=>no(abort())}));
                                if (id!==this.serial || command!==this.control) throw abort();
                                if(this.error) throw new Error(this.error.message);
                                // beta.7 Audio.play() restarts an already active source, and
                                // does not reset the position after ended. Preserve DOM semantics.
                                if(audio && !player.paused)return;
                                if(audio && player.ended && player.currentTime>=player.duration)player.currentTime=0;
                                try { await player.play(); if(id===this.serial && command===this.control) this.playing(); } catch (e) { if(id===this.serial && command===this.control) this.fail(e); throw e; }
                        })();
                        // Standard MV calls .play() without consuming the promise; onerror is its error path.
                        void p.catch(()=>{}); return p;
                }
                hostHold() {
                        const p=this.session?.player;
                        if(p && !p.paused && !p.ended) { ++this.control; this.resumeAfterMenu=true; p.pause(); }
                }
                hostRelease() {
                        const gated=this.gates.splice(0); for(const g of gated) g.open();
                        if(this.resumeAfterMenu) { this.resumeAfterMenu=false; if(!gated.length) void this.play().catch(()=>{}); }
                }
                pause() {
                        for(const cancel of this.pendingVoiceStarts)cancel(abort());this.pendingVoiceStarts.clear();
                        ++this.control; this.resumeAfterMenu=false;
                        for(const g of this.gates.splice(0)) g.cancel();
                        this.session?.player.pause();
                }
                stop() {
                        for(const cancel of this.pendingVoiceStarts)cancel(abort());this.pendingVoiceStarts.clear();
                        if(this.weak){voices.delete(this.weak);this.weak=undefined;}
                        ++this.serial; ++this.control; live.delete(this); this.clearProbe(); this.canPlayFired=false; this.didPlay=false; this.resumeAfterMenu=false;
                        for(const g of this.gates.splice(0)) g.cancel();
                        this.dropBackend(); this.selected=''; this.offerKey='';
                        this.task=undefined; this.error=null; this.firstFrame=false; this.seekTo=undefined;
                }
                drawable() { return !audio && this.firstFrame && !this.error ? this.session?.player : undefined; }
                visible() {
                        if (!this.drawable() || this.ended || this.hidden || this.style.display==='none' || this.style.visibility==='hidden' || (this.style.opacity!=null && this.style.opacity!=='' && Number(this.style.opacity)<=0)) return false;
                        const root=body(); for(let node:any=this; node; node=node.parentNode) if(node===root) return true;
                        return false;
                }
        }
        function visible() { for (const v of live) if (v.visible()) return v; }
        return { MovieNode, visible: () => !!visible(), setSuspended(value: boolean) {
                        if (suspended===value) return;
                        suspended=value; for (const v of members()) { if(value) v.hostHold(); else v.hostRelease(); }
                }, dispose() { retired=true; for(const v of members()) v.stop(); voices.clear(); },
                paint(ctx: any, x: number, y: number, w: number, h: number) {
                        const node=visible(); if (!node) return false;
                        const rect=viewport(node.videoWidth,node.videoHeight,w,h); if(!rect) return false;
                        ctx.save();
                        try {
                                ctx.setTransform(1,0,0,1,0,0); ctx.globalCompositeOperation='source-over';
                                ctx.globalAlpha=Math.max(0, Math.min(1,Number(node.style.opacity ?? 1)));
                                ctx.fillStyle='#000'; ctx.fillRect(x,y,w,h);
                                ctx.drawImage(node.drawable(),x+rect.x,y+rect.y,rect.width,rect.height);
                        } finally { ctx.restore(); }
                        return true;
                } };
}
