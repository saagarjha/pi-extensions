import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { NativeMode } from "./client-mode.ts";
import type { RemoteConnection } from "./client-connection.ts";

export type ClientReloadOptions = NonNullable<Parameters<AgentSession["reload"]>[0]>;
export interface PresentationRefresh extends ClientReloadOptions {
	/** Native /reload already owns UI reset, rendering policy and resource controls. */
	nativeReload: boolean;
}

/** The connection-backed session's reload lifecycle, beneath Pi's native handler.
 * Never reload an executor, reconnect, or take control. Native InteractiveMode
 * alone owns command policy, the reload box, keybindings, themes and notices.
 */
export function createClientReload({
	mode,
	remote,
	prepareReload,
	capturePresentation,
}: {
	mode: NativeMode;
	remote: RemoteConnection;
	prepareReload(): Promise<(refresh: PresentationRefresh) => Promise<void>>;
	/** Capture the current driver before preparation, including import-failure rollback. */
	capturePresentation(): () => Promise<void>;
}) {
	let running = false;
	let generation = 0;
	const assertReady = () => {
		if (!remote.connected) throw Error("Client reload requires a connected daemon session");
		if (remote.isController && remote.pendingRequests.length)
			throw Error("Finish the pending server dialog before reloading this client");
	};
	const refresh = async (options: PresentationRefresh): Promise<void> => {
		if (running) throw Error("Client reload is already in progress");
		running = true;
		const token = ++generation;
		const restore = capturePresentation();
		const sessionId = remote.sessionId;
		const replica = remote.replica;
		const terminal = mode.ui.terminal;
		const draft = mode.editor.getText();
		let releaseInput: (() => void) | undefined;
		let rebinding = false;
		let failed = false;
		let restored = false;
		try {
			releaseInput = mode.ui.addInputListener(() => ({ consume: true }));
			assertReady();
			const install = await prepareReload();
			assertReady();
			if (remote.sessionId !== sessionId || remote.replica !== replica)
				throw Error("Session changed during client reload");
			remote.beginRebind();
			rebinding = true;
			// Server selection is not a /reload command; it needs its own ordinary
			// presentation reset. Do not duplicate the native reload handler's reset.
			if (!options.nativeReload) mode.resetExtensionUI();
			await install(options);
			if (
				remote.sessionId !== sessionId ||
				remote.replica !== replica ||
				mode.ui.terminal !== terminal
			)
				throw Error("Client reload changed presentation identity");
		} catch (error) {
			failed = true;
			if (!rebinding) {
				remote.beginRebind();
				rebinding = true;
			}
			try {
				await restore();
				restored = true;
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					"Client reload and presentation rollback failed; disconnect and reopen this client",
				);
			}
			throw error;
		} finally {
			mode.editor.setText(draft);
			const restoredFacade = mode.session;
			const finish = async (guarded = false) => {
				try {
					if (
						guarded &&
						(token !== generation ||
							!remote.connected ||
							remote.sessionId !== sessionId ||
							remote.replica !== replica ||
							mode.session !== restoredFacade)
					)
						return;
					if (rebinding && (!failed || restored)) await remote.endRebind();
				} finally {
					releaseInput?.();
					if (token === generation) running = false;
				}
			};
			if (failed && options.nativeReload) {
				// Native catch restores its previousEditor after our rejection. Replay
				// custom editor/UI state afterwards, so editorContainer/focus and
				// mode.editor cannot disagree (e.g. queued-up versus the default editor).
				setImmediate(() => {
					void finish(true).catch(() => {
						if (token === generation && remote.connected && mode.session === restoredFacade)
							mode.showError("Client UI recovery failed; reconnect this client.");
					});
				});
			} else await finish();
		}
	};
	return {
		reload: (options: ClientReloadOptions = {}) => refresh({ ...options, nativeReload: true }),
		refreshPresentation: () => refresh({ nativeReload: false }),
	};
}
