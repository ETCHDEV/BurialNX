export type MenuItem = 'continue' | 'save' | 'load' | 'keymap' | 'another' | 'back' | 'quit'
        | 'saves' | 'import' | 'resolution' | 'fps' | 'mod' | 'direct' | 'snapshot' | 'language'
        | 'mouseSpeed' | 'frameSkip';

/** Controller-only overlay state. */
export class PauseMenu {
        open = false;
        fps = false;
        selected = 0;
        page: 1 | 2 = 1;
        languageCycle = 0;
        /** -1 / 0 / +1 — set by Left/Right while the mouseSpeed item is selected; consumed by the frame loop. */
        mouseSpeedDelta = 0;
        /** -1 / 0 / +1 — set by Left/Right while the frameSkip item is selected; consumed by the frame loop. */
        frameSkipDelta = 0;
        private pressed: boolean[] = Array(16).fill(false);
        private start: number | undefined;
        private armed = true;
        private waitForRelease = false;
        readonly itemsPage1: MenuItem[];
        readonly itemsPage2: MenuItem[];
        constructor(debug: boolean) {
                this.itemsPage1 = ['continue', 'save', 'load', 'keymap', 'another', 'quit'];
                this.itemsPage2 = debug
                        ? ['saves', 'import', 'resolution', 'fps', 'mouseSpeed', 'frameSkip', 'mod', 'direct', 'snapshot', 'language', 'back']
                        : ['saves', 'import', 'resolution', 'fps', 'mouseSpeed', 'frameSkip', 'mod', 'language', 'back'];
        }
        get currentItems(): MenuItem[] { return this.page === 1 ? this.itemsPage1 : this.itemsPage2; }
        get blocksInput() { return this.open || this.waitForRelease; }
        dismiss() { this.open = false; this.waitForRelease = true; this.page = 1; }
        step(buttons: ArrayLike<{ pressed: boolean }> | null, now: number, holdMs = 800, confirmIndex = 1, cancelIndex = 0): MenuItem | null {
                const down = (id: number) => !!buttons?.[id]?.pressed;
                const just = (id: number) => down(id) && !this.pressed[id];
                const justConfirm = () => just(confirmIndex);
                const justCancel = () => just(cancelIndex);
                if (!down(8)) { this.start = undefined; this.armed = true; }
                else if (this.armed) {
                        this.start ??= now;
                        if (now - this.start >= holdMs && !this.open) { this.open = true; this.armed = false; }
                }
                let action: MenuItem | null = null;
                const items = this.currentItems;
                this.languageCycle = 0;
                this.mouseSpeedDelta = 0;
                this.frameSkipDelta = 0;
                if (this.open) {
                        if (just(12)) this.selected = (this.selected + items.length - 1) % items.length;
                        if (just(13)) this.selected = (this.selected + 1) % items.length;
                        if (items[this.selected] === 'language') {
                                if (just(14)) this.languageCycle = -1;
                                if (just(15)) this.languageCycle = 1;
                        }
                        if (items[this.selected] === 'mouseSpeed') {
                                if (just(14)) this.mouseSpeedDelta = -1;
                                if (just(15)) this.mouseSpeedDelta = 1;
                        }
                        if (items[this.selected] === 'frameSkip') {
                                if (just(14)) this.frameSkipDelta = -1;
                                if (just(15)) this.frameSkipDelta = 1;
                        }
                        if (justCancel()) {
                                if (this.page === 2) { this.page = 1; this.selected = 4; }
                                else { this.open = false; this.waitForRelease = true; }
                        }
                        else if (justConfirm()) {
                                action = items[this.selected];
                                if (action === 'fps') this.fps = !this.fps;
                                if (action === 'another') { this.page = 2; this.selected = 0; action = null; }
                                else if (action === 'back') { this.page = 1; this.selected = 4; action = null; }
                                else if (action === 'continue' || action === 'save' || action === 'load') { this.open = false; this.waitForRelease = true; }
                                else if (action === 'language') { this.languageCycle = 1; action = null; }
                                else if (action === 'mouseSpeed') action = null;  // slider: Left/Right only, A is a no-op
                                else if (action === 'frameSkip') action = null;   // slider: Left/Right only, A is a no-op
                        }
                } else if (this.waitForRelease && !down(confirmIndex) && !down(cancelIndex) && !down(12) && !down(13)) this.waitForRelease = false;
                for (let index = 0; index < 16; index++) this.pressed[index] = down(index);
                return action;
        }
}
