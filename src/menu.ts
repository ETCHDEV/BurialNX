export type MenuItem = 'continue' | 'save' | 'load' | 'keymap' | 'another' | 'experimental' | 'back' | 'quit'
        | 'saves' | 'import' | 'resolution' | 'fps' | 'mod' | 'direct' | 'snapshot' | 'language'
        | 'mouseSpeed' | 'frameSkip' | 'messageRender'
        | 'skipFadeBlur' | 'skipFadeFill' | 'windowLayerSkip' | 'windowBitmapReuse'
        | 'textureGcIdle' | 'dirtyRenderSkip' | 'presentCache' | 'canvasNodeSkip';

/** Controller-only overlay state. */
export class PauseMenu {
        open = false;
        fps = false;
        selected = 0;
        page: 1 | 2 | 3 = 1;
        languageCycle = 0;
        /** -1 / 0 / +1 — set by Left/Right while the mouseSpeed item is selected; consumed by the frame loop. */
        mouseSpeedDelta = 0;
        /** -1 / 0 / +1 — set by Left/Right while the frameSkip item is selected; consumed by the frame loop. */
        frameSkipDelta = 0;
        /** -1 / 0 / +1 — set by Left/Right while the messageRender item is selected; consumed by the frame loop. */
        messageRenderDelta = 0;
        /** When non-null, the name of the AppState boolean field to flip on the next frame
         *  (set by A or Left/Right on a toggle item; consumed and cleared by the frame loop,
         *  which also persists the set to the selected game's library entry). Used by every
         *  on/off toggle on the Experimental page so we don't need a separate flag per item. */
        toggleExperimental: string | null = null;
        private pressed: boolean[] = Array(16).fill(false);
        private start: number | undefined;
        private armed = true;
        private waitForRelease = false;
        readonly itemsPage1: MenuItem[];
        readonly itemsPage2: MenuItem[];
        readonly itemsPage3: MenuItem[];
        constructor(debug: boolean) {
                this.itemsPage1 = ['continue', 'save', 'load', 'keymap', 'another', 'quit'];
                this.itemsPage2 = debug
                        ? ['saves', 'import', 'resolution', 'fps', 'mouseSpeed', 'mod', 'direct', 'snapshot', 'language', 'experimental']
                        : ['saves', 'import', 'resolution', 'fps', 'mouseSpeed', 'mod', 'language', 'experimental'];
                // Page 3 (Experimental): every FPS-improvement toggle. The first two are the
                // user-facing controls (slider + cycler); the rest are on/off toggles for the
                // individual patches documented in docs/doc/fps-optimizations.md.
                this.itemsPage3 = ['frameSkip', 'messageRender', 'skipFadeBlur', 'skipFadeFill',
                        'windowLayerSkip', 'windowBitmapReuse', 'textureGcIdle',
                        'dirtyRenderSkip', 'presentCache', 'canvasNodeSkip'];
        }
        get currentItems(): MenuItem[] { return this.page === 1 ? this.itemsPage1 : this.page === 2 ? this.itemsPage2 : this.itemsPage3; }
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
                this.messageRenderDelta = 0;
                this.toggleExperimental = null;
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
                        if (items[this.selected] === 'messageRender') {
                                if (just(14)) this.messageRenderDelta = -1;
                                if (just(15)) this.messageRenderDelta = 1;
                        }
                        // On/off toggles (Experimental page): A or Left/Right flips. The frame
                        // loop reads `toggleExperimental` (the S field name) and does the flip +
                        // persist. A boolean has no direction, so both Left and Right toggle.
                        switch (items[this.selected]) {
                                case 'skipFadeBlur': case 'skipFadeFill':
                                case 'windowLayerSkip': case 'windowBitmapReuse':
                                case 'textureGcIdle': case 'dirtyRenderSkip':
                                case 'presentCache': case 'canvasNodeSkip':
                                        if (justConfirm() || just(14) || just(15)) this.toggleExperimental = items[this.selected] as string;
                                        break;
                        }
                        if (justCancel()) {
                                if (this.page === 3) { this.page = 2; this.selected = this.itemsPage2.indexOf('experimental'); action = null; }
                                else if (this.page === 2) { this.page = 1; this.selected = 4; }
                                else { this.open = false; this.waitForRelease = true; }
                        }
                        else if (justConfirm()) {
                                action = items[this.selected];
                                if (action === 'fps') this.fps = !this.fps;
                                if (action === 'another') { this.page = 2; this.selected = 0; action = null; }
                                else if (action === 'experimental') { this.page = 3; this.selected = 0; action = null; }
                                else if (action === 'continue' || action === 'save' || action === 'load') { this.open = false; this.waitForRelease = true; }
                                else if (action === 'language') { this.languageCycle = 1; action = null; }
                                else if (action === 'mouseSpeed') action = null;  // slider: Left/Right only, A is a no-op
                                else if (action === 'frameSkip') action = null;   // slider: Left/Right only, A is a no-op
                                else if (action === 'messageRender') action = null; // cycler: Left/Right only, A is a no-op
                                // Toggle items already set toggleExperimental above; clear the
                                // action so the frame loop only does the toggle (not a quit/save/etc.).
                                else if (action === 'skipFadeBlur' || action === 'skipFadeFill'
                                        || action === 'windowLayerSkip' || action === 'windowBitmapReuse'
                                        || action === 'textureGcIdle' || action === 'dirtyRenderSkip'
                                        || action === 'presentCache' || action === 'canvasNodeSkip') action = null;
                        }
                } else if (this.waitForRelease && !down(confirmIndex) && !down(cancelIndex) && !down(12) && !down(13)) this.waitForRelease = false;
                for (let index = 0; index < 16; index++) this.pressed[index] = down(index);
                return action;
        }
}
