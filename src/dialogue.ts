/** A small optical adjustment raises center-screen interaction text. */
export function interactionTextY(available: number, content: number, artworkShift: number): number {
	if (![available, content, artworkShift].every(Number.isFinite) || available <= 0 || content <= 0) return 0;
	const free = Math.max(0, available - content);
	return Math.max(0, Math.min(free, free / 2 + artworkShift - Math.min(12, content / 3)));
}
