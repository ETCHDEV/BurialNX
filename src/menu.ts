export type MenuItem = 'continue' | 'load' | 'saves' | 'import' | 'resolution' | 'fps' | 'mod' | 'direct' | 'snapshot';

/** Controller-only overlay state. Button numbering follows the Web Gamepad API. */
export class PauseMenu {
	open = false;
	fps = false;
	selected = 0;
	private pressed: boolean[] = [];
	private start: number | undefined;
	private armed = true;
	private waitForRelease = false;
	readonly items: MenuItem[];
	constructor(debug: boolean) {
		this.items = debug ? ['continue', 'load', 'saves', 'import', 'resolution', 'fps', 'mod', 'direct', 'snapshot'] : ['continue', 'load', 'saves', 'import', 'resolution', 'fps', 'mod'];
	}
	get blocksInput() { return this.open || this.waitForRelease; }
	dismiss() { this.open = false; this.waitForRelease = true; }
	step(buttons: ArrayLike<{ pressed: boolean }> | null, now: number): MenuItem | null {
		const down = (id: number) => !!buttons?.[id]?.pressed;
		const just = (id: number) => down(id) && !this.pressed[id];
		if (!down(8)) { this.start = undefined; this.armed = true; }
		else if (this.armed) {
			this.start ??= now;
			if (now - this.start >= 800 && !this.open) { this.open = true; this.armed = false; }
		}
		let action: MenuItem | null = null;
		if (this.open) {
			if (just(12)) this.selected = (this.selected + this.items.length - 1) % this.items.length;
			if (just(13)) this.selected = (this.selected + 1) % this.items.length;
			if (just(0)) { this.open = false; this.waitForRelease = true; }
			else if (just(1)) {
				action = this.items[this.selected];
				if (action === 'fps') this.fps = !this.fps;
				if (action === 'continue' || action === 'load') { this.open = false; this.waitForRelease = true; }
			}
		} else if (this.waitForRelease && ![0, 1, 12, 13].some(down)) this.waitForRelease = false;
		this.pressed = Array.from({ length: 16 }, (_, index) => down(index));
		return action;
	}
}
