export interface StorageView { getItem(key: string): string | null; }

/** Match the previous loader's key namespace without modifying any saves. */
export function saveKey(root: string, slot: number, shared: boolean): string {
	if (!Number.isInteger(slot) || slot < -1) throw new Error('Invalid save slot');
	const label = slot === -1 ? 'Config' : slot === 0 ? 'Global' : `File${slot}`;
	const prefix = shared ? '' : `NX:${encodeURIComponent(root.replace(/\/+$/, ''))}:`;
	return `${prefix}RPG ${label}`;
}

/** A read-only view for an external slot picker; game code remains responsible for loading. */
export function listExistingSlots(storage: StorageView, root: string, shared: boolean, maxSlots: number): number[] {
	if (!Number.isInteger(maxSlots) || maxSlots < 0 || maxSlots > 999) throw new Error('Invalid save slot count');
	const found: number[] = [];
	for (let slot = 1; slot <= maxSlots; slot++) if (storage.getItem(saveKey(root, slot, shared)) !== null) found.push(slot);
	return found;
}
