import { ModelSelectorComponent, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveNativeCLIPath } from "./native-binding.ts";
import type { NativeMode } from "./client-mode.ts";
import type { RemoteConnection } from "./client-connection.ts";

async function loadComponents(mode: NativeMode) {
	// Resolve the running CLI installation, never the extension's typecheck-only SDK.
	const cli = resolveNativeCLIPath();
	const sdk = cli.endsWith("/bundle/cli.js") ? dirname(dirname(cli)) : dirname(cli);
	const nativeRequire = createRequire(pathToFileURL(join(sdk, "index.js")));
	const nativeTui = await import(pathToFileURL(nativeRequire.resolve("@earendil-works/pi-tui")).href);
	nativeTui.setKeybindings(mode.keybindings);
	const { ScopedModelsSelectorComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/scoped-models-selector.js")).href);
	const { resolveModelScopeFromModels } = await import(pathToFileURL(join(sdk, "core/model-resolver.js")).href);
	return { ScopedModelsSelectorComponent, resolveModelScopeFromModels };
}

/** Install safe hooks synchronously. Private SDK seams resolve only on picker use;
 * failure disables this feature, never the attached editor or worker session. */
export function installModelScopeUI(mode: NativeMode, remote: RemoteConnection, catalog: AgentSession["modelRuntime"]) {
	let loading: ReturnType<typeof loadComponents> | undefined;
	let request = 0;
	const supported = () => Array.isArray(remote.current.scopedModels) && !!remote.current.modelSettings && typeof remote.current.modelSettings === "object";
	const open = async (kind: "model" | "scope", search?: string) => {
		if (!supported()) { mode.showWarning("Model picker unavailable: worker update required (missing authoritative model-scope state)."); return; }
		const attempt = ++request, before = remote.snapshot;
		try {
		const { ScopedModelsSelectorComponent, resolveModelScopeFromModels } = await (loading ??= loadComponents(mode));
		const method = kind === "scope" ? "showModelsSelector" : "showModelSelector";
		if (attempt !== request || remote.snapshot !== before || !remote.connected || Reflect.get(mode, method) !== hooks[method]) return;
		if (!supported()) { mode.showWarning("Model picker unavailable: worker update required (missing authoritative model-scope state)."); return; }
		mode.showSelector(done => {
			const session = remote.sessionId, server = remote.serverIdentity, snapshot = remote.snapshot, generation = remote.controlGeneration;
			const valid = () => remote.connected && remote.sessionId === session && remote.serverIdentity === server && remote.snapshot === snapshot && remote.controlGeneration === generation;
			let disposed = false, pending = false, replaySave = false;
			const close = () => { disposed = true; done(); };
			const status = new Text("", 0, 0);
			const container = new Container();
			const redraw = (message: string) => { status.setText(message); mode.ui.requestRender(); };
			const run = async (action: () => Promise<unknown>, success: () => void) => {
				if (pending) return;
				if (!valid()) { redraw("Session changed/disconnected; close and reopen this picker. Draft not replayed."); return; }
				if (!remote.isController) { redraw("Watch-only: use /control before changing models. Draft retained."); return; }
				pending = true;
				redraw("Waiting for worker acknowledgement…");
				try {
					await action();
					if (!disposed && valid()) success();
				} catch (error) {
					if (!disposed) redraw(`${error instanceof Error ? error.message : String(error)}. Draft retained; save not confirmed.`);
				} finally { pending = false; if (!disposed) mode.ui.requestRender(); }
			};
			let selector: Component & Focusable & { dispose?: () => void; updateModels?: (models: unknown[], ids?: string[] | null) => void; getSearchInput?: () => unknown };
			let draft: string[] | null = null, dirty = false;
			const available = () => [...remote.current.catalog];
			const initialIds = (): string[] | null => {
				const live = remote.current;
				if (live.scopedModels?.length) return live.scopedModels.map(scope => `${scope.model.provider}/${scope.model.id}`);
				const patterns = live.modelSettings?.enabledModels;
				if (!patterns?.length) return null;
				const result = resolveModelScopeFromModels(patterns, available());
				return [...result.scopedModels.map((scope: { model: { provider: string; id: string } }) => `${scope.model.provider}/${scope.model.id}`),
					...result.diagnostics.filter((item: { code: string }) => item.code === "no-match").map((item: { pattern: string }) => item.pattern)];
			};
			const save = () => void run(() => remote.request("changeModelScope", { args: [draft, true] }), () => {
				dirty = false;
				// Native save clears its unsaved footer synchronously. Only replay AFTER ACK.
				replaySave = true;
				selector.handleInput?.(saveKey!);
				replaySave = false;
				redraw("Model selection saved to worker settings");
			});
			let saveKey: string | undefined;
			if (kind === "scope") {
				draft = initialIds();
				selector = new ScopedModelsSelectorComponent({ allModels: available(), enabledModelIds: draft }, {
					onChange: (ids: string[] | null) => {
						draft = ids; dirty = true;
						void run(() => remote.request("changeModelScope", { args: [ids, false] }), () => redraw("Session scope applied; not saved"));
					},
					onPersist: () => { if (!replaySave) save(); },
					onCancel: close,
				});
				void remote.request("refreshCatalog").then(() => {
					if (disposed || !valid()) return;
					if (!dirty) draft = initialIds();
					selector.updateModels?.(available(), dirty ? undefined : draft);
					mode.ui.requestRender();
				}).catch(error => { if (!disposed) redraw(`Catalog refresh failed: ${error}`); });
			} else {
				const select = (model: NonNullable<AgentSession["model"]>, persist: boolean) => void run(
					() => remote.request("setModel", { args: [{ provider: model.provider, id: model.id }, { persist }] }),
					() => { close(); mode.footer.invalidate(); mode.updateEditorBorderColor(); mode.showStatus(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.id}`); },
				);
				const defaults = remote.current.modelSettings;
				selector = new ModelSelectorComponent(mode.ui as TUI, remote.current.model, catalog,
					remote.current.scopedModels ?? [], model => select(model, false), close, search, model => select(model, true),
					defaults?.defaultProvider && defaults.defaultModel ? { provider: defaults.defaultProvider, id: defaults.defaultModel } : undefined);
			}
			container.addChild(selector);
			container.addChild(status);
			const input = {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				get focused() { return selector.focused; }, set focused(value: boolean) { selector.focused = value; },
				handleInput(data: string) {
					if ((pending || !valid()) && mode.keybindings.matches(data, "tui.select.cancel")) { close(); return; }
					if (!valid()) { redraw("Session changed/disconnected; close and reopen this picker. Draft not replayed."); return; }
					if (pending) return;
					if (kind === "scope" && mode.keybindings.matches(data, "app.models.save")) { saveKey = data; save(); return; }
					selector.handleInput?.(data);
				},
			};
			const unsubscribe = remote.subscribeFrames(() => {
				if (!valid()) redraw("Session changed/disconnected; close and reopen this picker. Draft not replayed.");
				else if (kind === "scope" && !dirty && !pending) { draft = initialIds(); selector.updateModels?.(available(), draft); mode.ui.requestRender(); }
			});
			return { component: input, focus: input, dispose: () => { disposed = true; unsubscribe(); selector.dispose?.(); } };
		});
		} catch (error) {
			loading = undefined;
			mode.showWarning(`Model picker unavailable: installed native UI could not be loaded (${error instanceof Error ? error.message : String(error)}). Update the client; the attached session is unchanged.`);
		}
	};
	const hooks = { showModelsSelector: () => { void open("scope"); }, showModelSelector: (search?: string) => { void open("model", search); } };
	Object.assign(mode, hooks);
}
