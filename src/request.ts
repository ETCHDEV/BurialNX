import type { Reader } from './library';

/** Minimal asynchronous local GET requests for future RPG Maker integration. */
export class LocalRequest extends EventTarget {
	readyState = 0;
	status = 0;
	statusText = '';
	responseType: '' | 'text' | 'arraybuffer' | 'json' = '';
	response: string | ArrayBuffer | unknown = null;
	responseText = '';
	responseURL = '';
	onreadystatechange: (() => void) | null = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	private sent = false;
	constructor(private assets: Reader) { super(); }
	open(method: string, path: string) {
		if (method.toUpperCase() !== 'GET') throw new Error('Only local GET is supported');
		this.responseURL = path;
		this.readyState = 1;
		this.sent = false;
		this.onreadystatechange?.();
	}
	overrideMimeType(_mime: string) { /* the response type controls decoding */ }
	async send() {
		if (this.readyState !== 1 || this.sent) throw new Error('Request is not open');
		this.sent = true;
		let data: ArrayBuffer | null;
		try { data = await this.assets.read(this.responseURL); }
		catch { data = null; }
		this.readyState = 4;
		if (data === null) {
			this.status = 404;
			this.statusText = 'Not Found';
			this.onreadystatechange?.();
			this.onerror?.();
			this.dispatchEvent(new Event('error'));
			return;
		}
		this.status = 200;
		this.statusText = 'OK';
		if (this.responseType === 'arraybuffer') this.response = data;
		else {
			this.responseText = new TextDecoder().decode(data);
			if (this.responseType === 'json') {
				try { this.response = JSON.parse(this.responseText); } catch { this.response = null; }
			} else this.response = this.responseText;
		}
		// Invoke game callbacks outside the I/O error handler: an exception in
		// game code must not be reported as a missing file and retried forever.
		this.onreadystatechange?.();
		this.onload?.();
		this.dispatchEvent(new Event('load'));
	}
}
