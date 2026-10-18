import type { Reader } from './library';

/** Serializes dynamically appended scripts to preserve game/plugin order. */
export class ScriptQueue {
	private tail: Promise<void> = Promise.resolve();
	private stopped: unknown;
	constructor(private assets: Reader, private evaluate: (source: string, path: string) => void) {}
	append(path: string): Promise<void> {
		const job = this.tail.then(async () => {
			if (this.stopped) throw this.stopped;
			const data = await this.assets.read(path);
			if (data === null) throw new Error(`Missing script: ${path}`);
			this.evaluate(new TextDecoder().decode(data), path);
		});
		// Retain failure so later scripts cannot execute after a broken dependency.
		this.tail = job.catch((error) => { this.stopped = error || new Error('Script failed'); });
		return job;
	}
	async settled(): Promise<void> {
		// A running script can append another script while the current tail is
		// executing, so wait until the queue has stopped growing.
		for (;;) {
			const last = this.tail;
			await last;
			if (last === this.tail) break;
		}
		if (this.stopped) throw this.stopped;
	}
}
