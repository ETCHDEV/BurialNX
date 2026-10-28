export type MenuItem = 'continue' | 'save' | 'load' | 'keymap' | 'another' | 'back' | 'quit'
        | 'saves' | 'import' | 'resolution' | 'fps' | 'mod' | 'direct' | 'snapshot' | 'language';

/** Controller-only overlay state. Button numbering follows the Web Gamepad API. */
export class PauseMenu {
        open = false;
        fps = false;
        selected = 0;
        page: 1 | 2 = 1; // 1 = main, 2 = "Another"
        /** Set by step() when Left/Right is pressed on the Language item.
         *  -1 = previous language, +1 = next language, 0 = no change.
         *  The frame function reads this after step() and cycles the language. */
        languageCycle = 0;
        private pressed: boolean[] = Array(16).fill(false);
        private start: number | undefined;
        private armed = true;
        private waitForRelease = false;
        readonly itemsPage1: MenuItem[];
        readonly itemsPage2: MenuItem[];
        constructor(debug: boolean) {
                // Page 1 (main): Resume, Save, Load, Edit keymap, Another, Quit
                this.itemsPage1 = ['continue', 'save', 'load', 'keymap', 'another', 'quit'];
                // Page 2 (Another): all remaining options + Back
                this.itemsPage2 = debug
                        ? ['saves', 'import', 'resolution', 'fps', 'mod', 'direct', 'snapshot', 'language', 'back']
                        : ['saves', 'import', 'resolution', 'fps', 'mod', 'language', 'back'];
        }
        get currentItems(): MenuItem[] { return this.page === 1 ? this.itemsPage1 : this.itemsPage2; }
        get blocksInput() { return this.open || this.waitForRelease; }
        dismiss() { this.open = false; this.waitForRelease = true; this.page = 1; }
        step(buttons: ArrayLike<{ pressed: boolean }> | null, now: number, holdMs = 800, confirmIndex = 1, cancelIndex = 0): MenuItem | null {
                const down = (id: number) => !!buttons?.[id]?.pressed;
                const just = (id: number) => down(id) && !this.pressed[id];
                // The pause menu mirrors the game's ok/cancel button mapping:
                // the button the game uses for 'ok' selects/confirms menu items,
                // the button the game uses for 'cancel' closes the menu / goes
                // back. confirmIndex/cancelIndex are computed by
                // menuButtonIndicesFor() in src/keymap.ts and passed in from the
                // frame loop (frame-loop.ts). Defaults (1, 0) reproduce the
                // long-standing BurialNX convention for games that haven't
                // remapped A/B.
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
                if (this.open) {
                        if (just(12)) this.selected = (this.selected + items.length - 1) % items.length;
                        if (just(13)) this.selected = (this.selected + 1) % items.length;
                        // Left/Right on the Language item cycle through languages with
                        // auto-confirm (no confirm press needed). The frame function reads
                        // languageCycle and saves the new preference immediately.
                        if (items[this.selected] === 'language') {
                                if (just(14)) this.languageCycle = -1; // Left
                                if (just(15)) this.languageCycle = 1;  // Right
                        }
                        if (justCancel()) { // CANCEL: close (or go back to page 1)
                                if (this.page === 2) { this.page = 1; this.selected = 4; }
                                else { this.open = false; this.waitForRelease = true; }
                        }
                        else if (justConfirm()) {
                                action = items[this.selected];
                                if (action === 'fps') this.fps = !this.fps;
                                if (action === 'another') { this.page = 2; this.selected = 0; action = null; }
                                else if (action === 'back') { this.page = 1; this.selected = 4; action = null; }
                                else if (action === 'continue' || action === 'save' || action === 'load') { this.open = false; this.waitForRelease = true; }
                                else if (action === 'language') { this.languageCycle = 1; action = null; } // confirm = cycle forward
                        }
                } else if (this.waitForRelease && !down(confirmIndex) && !down(cancelIndex) && !down(12) && !down(13)) this.waitForRelease = false;
                for (let index = 0; index < 16; index++) this.pressed[index] = down(index);
                return action;
        }
}
