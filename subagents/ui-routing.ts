import { ownedUI, remoteUI } from "../shared/owned-ui.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Child presentation belongs to the parent UI, not to a selected activity panel.
 * The parent native owner alone stores requests and fences answers. No child
 * request/promise is duplicated and notifications never become model messages.
 */
export function createParentUIRoute(
	parent: ExtensionUIContext,
	name: () => string,
	note: (message: string, kind: "info" | "warning" | "error") => void,
) {
	const lifecycle = new AbortController();
	const label = (title: string) => `[Subagent: ${name()}] ${title}`;
	const signalFor = (signal?: AbortSignal) => signal
		? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
	// SDK TUI editor() has no cancellation option. The native owner bridge
	// accepts dialog options for editor too; race cancellation also releases
	// the child when a local SDK UI cannot programmatically close its editor.
	function cancellable<T>(pending: Promise<T>, cancelled: T): Promise<T> {
		if (lifecycle.signal.aborted) { void pending.catch(() => {}); return Promise.resolve(cancelled); }
		return new Promise<T>((resolve, reject) => {
			const abort = () => resolve(cancelled);
			lifecycle.signal.addEventListener("abort", abort, { once: true });
			pending.then(resolve, reject).finally(() => lifecycle.signal.removeEventListener("abort", abort));
		});
	}
	const ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "editor" | "custom" | "notify"> = {
		select: (title, choices, options) => {
			if (lifecycle.signal.aborted) return Promise.resolve(undefined);
			return parent.select(label(title), choices, { ...options, signal: signalFor(options?.signal) });
		},
		confirm: (title, message, options) => {
			if (lifecycle.signal.aborted) return Promise.resolve(false);
			return parent.confirm(label(title), message, { ...options, signal: signalFor(options?.signal) });
		},
		input: (title, placeholder, options) => {
			if (lifecycle.signal.aborted) return Promise.resolve(undefined);
			return parent.input(label(title), placeholder, { ...options, signal: signalFor(options?.signal) });
		},
		editor: (title, prefill) => {
			if (lifecycle.signal.aborted) return Promise.resolve(undefined);
			const editor = parent.editor as (title: string, prefill?: string, options?: { signal: AbortSignal }) => Promise<string | undefined>;
			return cancellable(editor.call(parent, label(title), prefill, { signal: lifecycle.signal }), undefined);
		},
		notify: (message, kind = "info") => {
			if (lifecycle.signal.aborted) return;
			note(message, kind); // Existing panel status, never append/sendMessage.
			parent.notify(label(message), kind);
		},
		custom: <T>(factory: Parameters<ExtensionUIContext["custom"]>[0], options?: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T> => {
			if (lifecycle.signal.aborted) return Promise.resolve(undefined as T);
			return parent.custom<T>(async (tui, theme, keys, done) => {
				let finished = false;
				let disposeComponent: (() => void) | undefined;
				const finish = (value: T) => {
					if (finished) return;
					finished = true;
					lifecycle.signal.removeEventListener("abort", abort);
					try { done(value); }
					finally { disposeComponent?.(); }
				};
				const abort = () => finish(undefined as T);
				if (lifecycle.signal.aborted) {
					abort();
					return { render: () => [], invalidate: () => {} };
				}
				lifecycle.signal.addEventListener("abort", abort, { once: true });
				try {
					const component = await factory(tui, theme, keys, (value) => finish(value as T));
					let disposed = false;
					const dispose = () => {
						if (disposed) return;
						disposed = true;
						lifecycle.signal.removeEventListener("abort", abort);
						try { component?.dispose?.(); } catch { /* Same cleanup policy as the SDK host. */ }
					};
					disposeComponent = dispose;
					// The SDK TUI drops late factories without disposing their result.
					// Also own the gap between returning and host installation: finish
					// calls this same idempotent disposer if cancellation wins that race.
					if (finished || lifecycle.signal.aborted) {
						dispose();
						return { render: () => [], invalidate: () => {} };
					}
					return new Proxy(component, {
						get(target, property) {
							if (property === "render") return (width: number) => [truncateToWidth(label(""), width), ...target.render(width)];
							if (property === "dispose") return dispose;
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
						set: (target, property, value) => Reflect.set(target, property, value, target),
					});
				} catch (error) {
					lifecycle.signal.removeEventListener("abort", abort);
					throw error;
				}
			}, options);
		},
	};
	const remote = remoteUI(parent);
	if (remote)
		Object.assign(ui, {
			[ownedUI]: {
				remote: true,
				footer: () => {},
				status: () => {},
				present: (request: Parameters<typeof remote.present>[0]) => {
					if (lifecycle.signal.aborted) return Promise.resolve();
					return remote.present({
						...request,
						label: label(request.label ?? ""),
						signal: signalFor(request.signal),
					});
				},
			},
		});
	return {
		ui,
		get closed() {
			return lifecycle.signal.aborted;
		},
		close: () => lifecycle.abort(),
	};
}
