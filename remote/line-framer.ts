/** Newline framing for strings decoded by socket.setEncoding("utf8").
 * Scan each incoming chunk only once; assemble a fragmented line only when complete.
 * No frame-size limit: native session snapshots may contain arbitrarily large histories.
 */
export class LineFramer {
	private parts: string[] = [];

	*push(chunk: string): Generator<string> {
		let start = 0;
		let end: number;
		while ((end = chunk.indexOf("\n", start)) !== -1) {
			const tail = chunk.slice(start, end);
			let line: string;
			if (this.parts.length) {
				this.parts.push(tail);
				line = this.parts.join("");
				this.parts = [];
			} else line = tail;
			start = end + 1;
			yield line;
		}
		if (start < chunk.length) this.parts.push(chunk.slice(start));
	}
}
