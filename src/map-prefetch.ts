import type { Reader } from './library';

// MV's transfer command names the destination directly only when the first
// parameter is zero. Variable-based destinations cannot be predicted safely.
const MAX_MAPS = 3;
const MAX_INSPECTED = 10000;
const START_DELAY_MS = 1000;
const BETWEEN_READS_MS = 250;

export class MapPrefetcher {
	private queue: string[] = [];
	private generation = 0;
	private active = false;
	private nextRead = 0;

	constructor(private assets: Reader, private log: (line: string) => void, private clock = () => performance.now()) {}

	plan(map: any) {
		const destinations = new Set<number>();
		let inspected = 0;
		// Count events and pages as well as commands so even unusual maps have
		// a bounded scan. Missing or malformed event lists are simply ignored.
		outer: for (const event of Array.isArray(map?.events) ? map.events : []) {
			if (++inspected > MAX_INSPECTED) break;
			for (const page of Array.isArray(event?.pages) ? event.pages : []) {
				if (++inspected > MAX_INSPECTED) break outer;
				for (const command of Array.isArray(page?.list) ? page.list : []) {
					if (++inspected > MAX_INSPECTED) break outer;
					const p = command?.parameters;
					if (command?.code === 201 && Array.isArray(p) && p[0] === 0 && Number.isInteger(p[1]) && p[1] > 0 && p[1] <= 9999) {
						destinations.add(p[1]);
						if (destinations.size >= MAX_MAPS) break outer;
					}
				}
			}
		}
		this.queue = Array.from(destinations, (id) => `data/Map${String(id).padStart(3, '0')}.json`);
		this.generation++;
		this.nextRead = this.clock() + START_DELAY_MS;
	}

	// Called once per frame, but issues at most one asynchronous read at a
	// time. A new map discards the old queue; an already-started read may finish.
	tick(now: number, idle: boolean) {
		if (!idle || this.active || now < this.nextRead || !this.queue.length) return;
		const path = this.queue.shift()!;
		const generation = this.generation;
		this.active = true;
		void Promise.resolve().then(() => this.assets.read(path)).catch((error) => {
			this.log(`Map prefetch failed: ${path}: ${String(error)}`);
		}).finally(() => {
			this.active = false;
			if (generation === this.generation) this.nextRead = this.clock() + BETWEEN_READS_MS;
		});
	}
}

/** Observe normal MV map loads without changing the data given to the game. */
export function installMapPrefetch(runtime: any, prefetch: MapPrefetcher, log: (line: string) => void): boolean {
	const manager = runtime.DataManager;
	if (typeof manager?.onLoad !== 'function') return false;
	const onLoad = manager.onLoad;
	manager.onLoad = function(object: unknown) {
		const result = onLoad.apply(this, arguments);
		if (object && object === runtime.$dataMap) {
			try { prefetch.plan(object); } catch (error) { log(`Map prefetch planning failed: ${String(error)}`); }
		}
		return result;
	};
	return true;
}
