interface StartupNoticesMode {
	showStartupNoticesIfNeeded(): void;
	ui: { requestRender(): void };
}

/** Native notices live in chatContainer, which the first remote rebind clears.
 * Defer only this client's first presentation; keep native cached content and
 * seen-version semantics, without adding anything to the canonical session.
 */
export async function withDeferredStartupNotices(
	mode: StartupNoticesMode,
	startup: () => Promise<void>,
): Promise<void> {
	const show = mode.showStartupNoticesIfNeeded;
	const own = Object.getOwnPropertyDescriptor(mode, "showStartupNoticesIfNeeded");
	Object.defineProperty(mode, "showStartupNoticesIfNeeded", {
		value: () => {},
		writable: true,
		configurable: true,
	});
	try {
		await startup();
	} finally {
		if (own) Object.defineProperty(mode, "showStartupNoticesIfNeeded", own);
		else delete (mode as Partial<StartupNoticesMode>).showStartupNoticesIfNeeded;
	}
	// Only successful startup gets a presentation. Failures retain the caller's
	// native shutdown path; never turn a failed attachment into a local fallback.
	show.call(mode);
	mode.ui.requestRender();
}
