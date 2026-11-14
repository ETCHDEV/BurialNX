export interface DirectoryAccess {
        readDirSync(path: string): string[] | null;
        statSync(path: string): { mode: number } | null;
}

const isDirectory = (mode: number) => (mode & 0o170000) === 0o040000;
const isFile = (mode: number) => (mode & 0o170000) === 0o100000;
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

export function gameRoot(fs: DirectoryAccess, folder: string): string | null {
        for (const candidate of [folder, join(folder, 'www')]) {
                try {
                        const index = fs.statSync(join(candidate, 'index.html'));
                        const core = fs.statSync(join(candidate, 'js/rpg_core.js'));
                        if (index && core && isFile(index.mode) && isFile(core.mode)) return candidate;
                } catch {}
        }
        return null;
}

/** Game or mod folder selection never opens or writes to a game file. */
export class FolderBrowser {
        path = 'sdmc:';
        selected = 0;
        entries: string[] = [];
        message = '';
        sharedSaves = false;
        pickedFile: string | null = null;
        private previous: boolean[] = [];
        constructor(private fs: DirectoryAccess & { readFileSync?(path: string): ArrayBuffer | null }, readonly mode: 'game' | 'mod' | 'saves' | 'image' | 'file', startPath?: string) {
                if (startPath) this.path = startPath;
                this.refresh();
        }
        private refresh() {
                try {
                        this.entries = (this.fs.readDirSync(`${this.path}/`) || []).filter((name) => {
                                if (!name || name === '.' || name === '..' || /[\\/:\u0000-\u001f\u007f\u2028\u2029]/.test(name)) return false;
                                try {
                                        const info = this.fs.statSync(join(this.path, name));
                                        if (!info) return false;
                                        if (this.mode === 'image' && isFile(info.mode)) {
                                                const ext = name.toLowerCase().split('.').pop() || '';
                                                return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'exe'].includes(ext);
                                        }
                                        if (this.mode === 'file' && isFile(info.mode)) return true;
                                        return isDirectory(info.mode);
                                } catch { return false; }
                        }).sort((a, b) => a.localeCompare(b));
                } catch { this.entries = []; this.message = 'Cannot read folder.'; }
                this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
                this.pickedFile = null;
        }
        step(buttons: ArrayLike<{ pressed: boolean }> | null, confirmIndex = 1, cancelIndex = 0): string | null | undefined {
                const down = (id: number) => !!buttons?.[id]?.pressed;
                const edge = (id: number) => down(id) && !this.previous[id];
                const edgeConfirm = () => edge(confirmIndex);
                const edgeCancel = () => edge(cancelIndex);
                let result: string | null | undefined;
                if (edge(12) && this.entries.length) this.selected = (this.selected + this.entries.length - 1) % this.entries.length;
                if (edge(13) && this.entries.length) this.selected = (this.selected + 1) % this.entries.length;
                const entry = this.entries[this.selected];
                if (edgeConfirm() && entry) {
                        if (this.mode === 'image' || this.mode === 'file') {
                                // In image/file mode A picks a file, not a folder.
                                const info = this.fs.statSync(join(this.path, entry));
                                if (info && isFile(info.mode)) { result = join(this.path, entry); this.pickedFile = result; }
                                else { this.path = join(this.path, entry); this.selected = 0; this.message = ''; this.refresh(); }
                        } else { this.path = join(this.path, entry); this.selected = 0; this.message = ''; this.refresh(); }
                }
                if (edgeCancel()) {
                        if (this.path !== 'sdmc:') { this.path = this.path.slice(0, this.path.lastIndexOf('/')); this.selected = 0; this.message = ''; this.refresh(); }
                        else result = null;
                }
                if ((edge(3) || this.mode === 'game' && edge(2)) && entry && this.mode !== 'image' && this.mode !== 'file') {
                        const chosen = join(this.path, entry);
                        result = this.mode !== 'game' ? chosen : gameRoot(this.fs, chosen) || undefined;
                        if (result && this.mode === 'game') this.sharedSaves = edge(2);
                        if (!result) this.message = 'No supported game found in that folder.';
                }
                if (edge(3) && this.mode === 'file' && entry) {
                        result = join(this.path, entry);
                        this.pickedFile = result;
                }
                if (edge(2) && this.mode === 'mod') result = null;
                this.previous = Array.from({ length: 16 }, (_, i) => down(i));
                return result;
        }
}
