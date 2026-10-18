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
		} catch { /* another candidate may work */ }
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
	private previous: boolean[] = [];
	constructor(private fs: DirectoryAccess, readonly mode: 'game' | 'mod' | 'saves') { this.refresh(); }
	private refresh() {
		try {
			this.entries = (this.fs.readDirSync(`${this.path}/`) || []).filter((name) => {
				if (!name || name === '.' || name === '..' || /[\\/:\u0000-\u001f\u007f\u2028\u2029]/.test(name)) return false;
				try { const info = this.fs.statSync(join(this.path, name)); return !!info && isDirectory(info.mode); } catch { return false; }
			}).sort((a, b) => a.localeCompare(b));
		} catch { this.entries = []; this.message = 'Cannot read folder.'; }
		this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
	}
	step(buttons: ArrayLike<{ pressed: boolean }> | null): string | null | undefined {
		const down = (id: number) => !!buttons?.[id]?.pressed;
		const edge = (id: number) => down(id) && !this.previous[id];
		let result: string | null | undefined;
		if (edge(12) && this.entries.length) this.selected = (this.selected + this.entries.length - 1) % this.entries.length;
		if (edge(13) && this.entries.length) this.selected = (this.selected + 1) % this.entries.length;
		const entry = this.entries[this.selected];
		if (edge(1) && entry) { this.path = join(this.path, entry); this.selected = 0; this.message = ''; this.refresh(); }
		if (edge(0) && this.path !== 'sdmc:') { this.path = this.path.slice(0, this.path.lastIndexOf('/')); this.selected = 0; this.message = ''; this.refresh(); }
		else if (edge(0) && this.mode === 'saves') result = null;
		if ((edge(3) || this.mode === 'game' && edge(2)) && entry) {
			const chosen = join(this.path, entry);
			result = this.mode !== 'game' ? chosen : gameRoot(this.fs, chosen) || undefined;
			if (result && this.mode === 'game') this.sharedSaves = edge(2);
			if (!result) this.message = 'No supported game found in that folder.';
		}
		if (edge(2) && this.mode === 'mod') result = null;
		this.previous = Array.from({ length: 16 }, (_, i) => down(i));
		return result;
	}
}
