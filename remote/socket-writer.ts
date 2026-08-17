import type { Socket } from "node:net";

// Bound each native write, not the frame size. Large pending writes can incur
// repeated native buffer copies while Bun drains a backpressured Unix socket.
// Encode each frame once, then pass bounded, zero-copy views to the socket.
const CHUNK_BYTES = 48 * 1024;
const writers = new WeakMap<Socket, SocketWriter>();

class SocketWriter {
	private pending: Array<{ bytes: Buffer; offset: number }> = [];
	private waiting = false;
	private pumping = false;
	private closed = false;

	constructor(private readonly socket: Socket) {
		socket.once("close", this.clear);
		socket.once("error", this.clear);
	}

	write(text: string): void {
		if (this.closed || this.socket.destroyed || !text.length) return;
		this.pending.push({ bytes: Buffer.from(text, "utf8"), offset: 0 });
		this.pump();
	}

	private clear = () => {
		this.closed = true;
		this.pending.length = 0;
		this.socket.off("drain", this.resume);
	};

	private resume = () => {
		this.waiting = false;
		this.pump();
	};

	private pump(): void {
		if (this.closed || this.waiting || this.pumping) return;
		this.pumping = true;
		try {
			while (!this.closed && !this.socket.destroyed && this.pending.length) {
				const frame = this.pending[0]!;
				const end = Math.min(frame.offset + CHUNK_BYTES, frame.bytes.length);
				const chunk = frame.bytes.subarray(frame.offset, end);
				frame.offset = end;
				if (end === frame.bytes.length) this.pending.shift();
				const accepted = this.socket.write(chunk);
				if (this.closed || this.socket.destroyed) return;
				if (!accepted) {
					this.waiting = true;
					this.socket.once("drain", this.resume);
					return;
				}
			}
		} catch (error) {
			this.clear();
			throw error;
		} finally {
			this.pumping = false;
		}
	}
}

/** Every write on a shared outgoing socket must use this queue, including
 * small replies/events and delimiters, so no frame can interleave with a drain. */
export function writeSocket(socket: Socket, text: string): void {
	if (socket.destroyed) return;
	let writer = writers.get(socket);
	if (!writer) {
		writer = new SocketWriter(socket);
		writers.set(socket, writer);
	}
	writer.write(text);
}
