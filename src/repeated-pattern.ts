type Repeat = 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';
type Surface = { width: number; height: number; getContext(kind: '2d'): any };

/** A small substitute for the CanvasPattern operation used by PIXI 4. */
export class RepeatedPattern {
        private tile: { surface: any; width: number; height: number; version: number } | null = null;
        readonly repeat: Repeat;

        constructor(readonly source: any, repeat: string, private version: () => number = () => 0) {
                const value = repeat || 'repeat';
                if (!['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].includes(value)) throw new TypeError('Invalid pattern repetition');
                this.repeat = value as Repeat;
        }

        /** Build a bounded, repeated tile so a 1px source does not cost a draw per pixel. */
        private enlarged(makeCanvas: (width: number, height: number) => Surface) {
                const width = this.source.width, height = this.source.height, version = this.version();
                if (this.tile && this.tile.version === version) return this.tile;
                const limit = 256, pixels = limit * limit;
                const horizontal = this.repeat === 'repeat' || this.repeat === 'repeat-x';
                const vertical = this.repeat === 'repeat' || this.repeat === 'repeat-y';
                const cols = horizontal ? Math.max(1, Math.min(Math.floor(limit / width), Math.floor(pixels / (width * height)))) : 1;
                const rows = vertical ? Math.max(1, Math.min(Math.floor(limit / height), Math.floor(pixels / (width * height * cols)))) : 1;
                if (cols === 1 && rows === 1) return this.tile = { surface: this.source, width, height, version };
                const canvas = makeCanvas(width * cols, height * rows), ctx = canvas.getContext('2d');
                ctx.drawImage(this.source, 0, 0);
                for (let filled = width; filled < canvas.width;) {
                        const copy = Math.min(filled, canvas.width - filled);
                        ctx.drawImage(canvas, 0, 0, copy, height, filled, 0, copy, height);
                        filled += copy;
                }
                for (let filled = height; filled < canvas.height;) {
                        const copy = Math.min(filled, canvas.height - filled);
                        ctx.drawImage(canvas, 0, 0, canvas.width, copy, 0, filled, canvas.width, copy);
                        filled += copy;
                }
                return this.tile = { surface: canvas, width: canvas.width, height: canvas.height, version };
        }

        fill(ctx: any, x: number, y: number, width: number, height: number, makeCanvas: (width: number, height: number) => Surface) {
                const sw = this.source?.width, sh = this.source?.height;
                if (![x, y, width, height, sw, sh].every(Number.isFinite) || !width || !height || sw <= 0 || sh <= 0) return;
                const tile = this.enlarged(makeCanvas);
                const left = Math.min(x, x + width), right = Math.max(x, x + width);
                const top = Math.min(y, y + height), bottom = Math.max(y, y + height);
                const repeatX = this.repeat === 'repeat' || this.repeat === 'repeat-x';
                const repeatY = this.repeat === 'repeat' || this.repeat === 'repeat-y';
                const firstX = repeatX ? Math.floor(left / tile.width) * tile.width : 0;
                const firstY = repeatY ? Math.floor(top / tile.height) * tile.height : 0;
                for (let py = firstY; py < bottom; py += tile.height) {
                        const y0 = Math.max(top, py), y1 = Math.min(bottom, py + tile.height);
                        for (let px = firstX; px < right; px += tile.width) {
                                const x0 = Math.max(left, px), x1 = Math.min(right, px + tile.width);
                                if (x1 > x0 && y1 > y0) ctx.drawImage(tile.surface, x0 - px, y0 - py, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
                                if (!repeatX) break;
                        }
                        if (!repeatY) break;
                }
        }
}
