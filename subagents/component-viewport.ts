import type { Component } from "@earendil-works/pi-tui";

/** Layout only: opaque native components, no messages, roles, tool IDs or pairing.
 * Keeps32 viewport line caches; native component allocation itself remains eager. */
export class ComponentViewport {
	private width = 0;
	private anchor?: { component: Component; end: number };
	private cells = new Map<Component, { width: number; lines: string[] }>();
	private invalidation = 0;
	private invalidated = new WeakMap<Component, number>();
	private indexed: readonly Component[] | undefined;
	private indexedCount = 0;
	private indexedLast?: Component;
	private indices = new WeakMap<Component, number>();
	constructor(private components: () => readonly Component[]) {}
	private get nodes() {
		return this.components();
	}
	private index(component: Component) {
		const nodes = this.nodes;
		if (
			nodes !== this.indexed ||
			nodes.length < this.indexedCount ||
			nodes[this.indexedCount - 1] !== this.indexedLast
		) {
			this.indices = new WeakMap();
			this.indexedCount = 0;
		}
		this.indexed = nodes;
		while (this.indexedCount < nodes.length) {
			this.indices.set(nodes[this.indexedCount]!, this.indexedCount);
			this.indexedCount++;
		}
		this.indexedLast = nodes[this.indexedCount - 1];
		const index = this.indices.get(component);
		return index !== undefined && nodes[index] === component ? index : nodes.indexOf(component);
	}
	bottom() {
		this.anchor = undefined;
		this.indexed = undefined;
		this.indexedCount = 0;
		this.indexedLast = undefined;
		this.indices = new WeakMap();
	}
	changed() {
		this.cells.clear();
	}
	invalidate() {
		this.invalidation++;
		this.changed();
	}
	dispose() {
		this.cells.clear();
		this.bottom();
	}
	private lines(index: number): string[] {
		const component = this.nodes[index]!;
		let cell = this.cells.get(component);
		if (!cell || cell.width !== this.width) {
			if (this.invalidated.get(component) !== this.invalidation) {
				component.invalidate();
				this.invalidated.set(component, this.invalidation);
			}
			cell = { width: this.width, lines: component.render(this.width) };
		}
		this.cells.delete(component);
		this.cells.set(component, cell);
		while (this.cells.size > 32) this.cells.delete(this.cells.keys().next().value!);
		return cell.lines;
	}
	scroll(delta: number) {
		if (!this.width || !this.nodes.length) return;
		let i = this.anchor ? this.index(this.anchor.component) : this.nodes.length - 1;
		if (i < 0) {
			this.anchor = undefined;
			return;
		}
		let end = this.anchor?.end ?? this.lines(i).length;
		if (delta > 0) {
			let remaining = delta;
			while (remaining > 0) {
				const step = Math.min(end, remaining);
				end -= step;
				remaining -= step;
				if (!remaining || i === 0) break;
				end = this.lines(--i).length;
			}
		} else {
			let remaining = -delta;
			while (remaining > 0) {
				const step = Math.min(Math.max(0, this.lines(i).length - end), remaining);
				end += step;
				remaining -= step;
				if (!remaining || i === this.nodes.length - 1) break;
				i++;
				end = 0;
			}
			if (i === this.nodes.length - 1 && end >= this.lines(i).length) {
				this.anchor = undefined;
				return;
			}
		}
		this.anchor = { component: this.nodes[i]!, end };
	}
	render(width: number, height: number): { lines: string[]; earlier: boolean; later: boolean; first?: Component } {
		this.width = width;
		if (!this.nodes.length)
			return {
				lines: ["No transcript yet."],
				earlier: false,
				later: false,
			};
		let i = this.anchor ? this.index(this.anchor.component) : this.nodes.length - 1;
		if (i < 0) {
			this.anchor = undefined;
			i = this.nodes.length - 1;
		}
		let end = this.anchor ? Math.min(this.anchor.end, this.lines(i).length) : this.lines(i).length;
		const later = !!this.anchor && (i < this.nodes.length - 1 || end < this.lines(i).length);
		const lines: string[] = [];
		let first: Component | undefined;
		while (i >= 0 && lines.length < height) {
			const row = this.lines(i);
			const start = Math.max(0, end - (height - lines.length));
			if (end > start) first = this.nodes[i];
			lines.unshift(...row.slice(start, end));
			if (start > 0) return { lines, earlier: true, later, first };
			if (--i >= 0) end = this.lines(i).length;
		}
		// Clamp at the first page, not an empty viewport above the first row. This
		// measures only that visible page; no prefix-height table is maintained.
		if (this.anchor && i < 0 && lines.length < height) {
			lines.length = 0;
			let index = 0,
				end = 0;
			while (index < this.nodes.length && lines.length < height) {
				const row = this.lines(index);
				end = Math.min(row.length, height - lines.length);
				lines.push(...row.slice(0, end));
				if (lines.length >= height || index === this.nodes.length - 1) break;
				index++;
			}
			this.anchor = { component: this.nodes[index]!, end };
			const hasLater = index < this.nodes.length - 1 || end < this.lines(index).length;
			if (!hasLater) this.anchor = undefined;
			return { lines, earlier: false, later: hasLater };
		}
		return { lines, earlier: i >= 0, later, first };
	}
}
