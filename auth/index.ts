import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	LoginDialogComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, AuthEvent, AuthPrompt, Model, ModelsPublication, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
type AccountProvider = {
	/** Provider id pi stores credentials under, e.g. anthropic-work or anthropic-work-max. */
	providerId: string;
	/** Built-in/source provider being wrapped, e.g. anthropic. */
	baseProviderId: string;
	authType: "oauth" | "api_key";
	label?: string;
};

interface Store {
	profiles: string[];
	/** Account profile -> wrapped providers/logins in that profile. */
	providers: Record<string, AccountProvider[]>;
	/** Legacy field from the old auth.json-rewriting implementation; retained so existing files parse. */
	credentials?: Record<string, Record<string, Record<string, unknown>>>;
}

const storePath = join(getAgentDir(), "auth-accounts.json");

function readJson<T>(path: string, fallback: T): T {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; }
	catch { return fallback; }
}

function readStore(): Store {
	const raw = readJson<Partial<Store>>(storePath, {});
	const providers = raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers) ? raw.providers : {};
	const profiles = Array.isArray(raw.profiles) ? raw.profiles.filter((name): name is string => typeof name === "string") : [];
	for (const name of Object.keys(providers)) if (!profiles.includes(name)) profiles.push(name);
	const legacyCredentials = raw.credentials && typeof raw.credentials === "object" && !Array.isArray(raw.credentials) ? raw.credentials : undefined;
	for (const name of Object.keys(legacyCredentials ?? {})) if (!profiles.includes(name)) profiles.push(name);
	return {
		profiles: profiles.sort(),
		providers: providers as Store["providers"],
		credentials: legacyCredentials as Store["credentials"],
	};
}

function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

function writeStore(store: Store): void {
	const normalized: Store = {
		profiles: [...new Set(store.profiles)].sort(),
		providers: Object.fromEntries(Object.entries(store.providers).map(([account, providers]) => [account, dedupeProviders(providers)])),
		...(store.credentials ? { credentials: store.credentials } : {}),
	};
	writeFileAtomic(storePath, `${JSON.stringify(normalized, null, 2)}\n`);
}

function dedupeProviders(providers: AccountProvider[]): AccountProvider[] {
	const byId = new Map<string, AccountProvider>();
	for (const provider of providers) byId.set(provider.providerId, provider);
	return [...byId.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function safePart(text: string): string {
	return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

function aliasProviderId(baseProviderId: string, account: string, label?: string): string {
	return [safePart(baseProviderId), safePart(account), label ? safePart(label) : undefined].filter(Boolean).join("-");
}

function isAccountAlias(providerId: string): boolean {
	const store = readStore();
	return Object.values(store.providers).some((providers) => providers.some((provider) => provider.providerId === providerId));
}

function runtime(ctx: ExtensionContext): any {
	return (ctx.modelRegistry as any).runtime;
}

function providerAuthTypes(provider: Provider<Api>): Array<"oauth" | "api_key"> {
	return [provider.auth.oauth ? "oauth" : undefined, provider.auth.apiKey?.login ? "api_key" : undefined].filter(Boolean) as Array<"oauth" | "api_key">;
}

function authTypeLabel(type: "oauth" | "api_key"): string {
	return type === "oauth" ? "Sign in with an account" : "Sign in with an API key";
}

function baseProviders(ctx: ExtensionContext, authType?: "oauth" | "api_key"): Provider<Api>[] {
	return runtime(ctx).getProviders()
		.filter((provider: Provider<Api>) => !isAccountAlias(provider.id))
		.filter((provider: Provider<Api>) => !authType || providerAuthTypes(provider).includes(authType))
		.sort((a: Provider<Api>, b: Provider<Api>) => a.name.localeCompare(b.name));
}

function cloneProviderForAccount(ctx: ExtensionContext, account: string, entry: AccountProvider): boolean {
	const base = ctx.modelRegistry.getProvider(entry.baseProviderId) as Provider<Api> | undefined;
	if (!base) return false;
	const alias = entry.providerId;
	const toAlias = (model: Model<Api>): Model<Api> => ({ ...model, provider: alias });
	const toBase = (model: Model<Api>): Model<Api> => ({ ...model, provider: base.id });
	let aliasModels = base.getModels().map(toAlias);
	const refreshModels = base.refreshModels
		? async (refreshCtx: RefreshModelsContext): Promise<void> => {
				const stored = refreshCtx.stored
					? { ...refreshCtx.stored, models: refreshCtx.stored.models.map(toBase) }
					: undefined;
				await base.refreshModels!({
					...refreshCtx,
					stored,
					publish: (publication: ModelsPublication) => refreshCtx.publish({
						...publication,
						persist: publication.persist && { ...publication.persist, models: publication.persist.models.map(toAlias) },
						update: () => {
							if (publication.persist === null) aliasModels = [];
							else if (publication.persist) aliasModels = publication.persist.models.map(toAlias);
							else if (refreshCtx.stored) aliasModels = refreshCtx.stored.models.map(toAlias);
							else aliasModels = base.getModels().map(toAlias);
						},
					}),
				});
			}
		: undefined;
	const aliasProvider: Provider<Api> = {
		id: alias,
		name: `${base.name} (${account}${entry.label ? ` · ${entry.label}` : ""})`,
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: base.auth,
		getModels: () => base.refreshModels ? aliasModels : base.getModels().map(toAlias),
		...(refreshModels ? { refreshModels } : {}),
		...(base.filterModels ? {
			filterModels: (models: readonly Model<Api>[], credential: any) => {
				const baseModels = models.map(toBase);
				const allowed = new Set(base.filterModels!(baseModels, credential).map((model) => model.id));
				return models.filter((model) => allowed.has(model.id));
			},
		} : {}),
		stream: (model, context, options) => base.stream(toBase(model), context, options),
		streamSimple: (model, context, options) => base.streamSimple(toBase(model), context, options),
		...(base.fetchDeferred ? { fetchDeferred: (model: any, handle: any, options: any) => base.fetchDeferred!(toBase(model), handle, options) } : {}),
		...(base.cancelDeferred ? { cancelDeferred: (model: any, handle: any, options: any) => base.cancelDeferred!(toBase(model), handle, options) } : {}),
	};
	ctx.modelRegistry.registerProvider(aliasProvider);
	return true;
}

function cloneBuiltinProviderForAccount(account: string, entry: AccountProvider): Provider<Api> | undefined {
	const base = builtinProviders().find((provider) => provider.id === entry.baseProviderId) as Provider<Api> | undefined;
	if (!base) return undefined;
	const alias = entry.providerId;
	const toAlias = (model: Model<Api>): Model<Api> => ({ ...model, provider: alias });
	const toBase = (model: Model<Api>): Model<Api> => ({ ...model, provider: base.id });
	return {
		id: alias,
		name: `${base.name} (${account}${entry.label ? ` · ${entry.label}` : ""})`,
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: base.auth,
		getModels: () => base.getModels().map(toAlias),
		...(base.filterModels ? {
			filterModels: (models: readonly Model<Api>[], credential: any) => {
				const baseModels = models.map(toBase);
				const allowed = new Set(base.filterModels!(baseModels, credential).map((model) => model.id));
				return models.filter((model) => allowed.has(model.id));
			},
		} : {}),
		stream: (model, context, options) => base.stream(toBase(model), context, options),
		streamSimple: (model, context, options) => base.streamSimple(toBase(model), context, options),
		...(base.fetchDeferred ? { fetchDeferred: (model: any, handle: any, options: any) => base.fetchDeferred!(toBase(model), handle, options) } : {}),
		...(base.cancelDeferred ? { cancelDeferred: (model: any, handle: any, options: any) => base.cancelDeferred!(toBase(model), handle, options) } : {}),
	};
}

function registerBuiltinAccountProviders(pi: ExtensionAPI): number {
	const store = readStore();
	let count = 0;
	for (const name of store.profiles) {
		for (const entry of store.providers[name] ?? []) {
			const provider = cloneBuiltinProviderForAccount(name, entry);
			if (provider) {
				pi.registerProvider(provider);
				count++;
			}
		}
	}
	return count;
}

function registerAccountProviders(ctx: ExtensionContext, account?: string): number {
	const store = readStore();
	let count = 0;
	const names = account ? [account] : store.profiles;
	for (const name of names) {
		for (const entry of store.providers[name] ?? []) {
			if (cloneProviderForAccount(ctx, name, entry)) count++;
		}
	}
	return count;
}

function accountForProvider(providerId: string): string | undefined {
	const store = readStore();
	for (const [account, providers] of Object.entries(store.providers)) {
		if (providers.some((provider) => provider.providerId === providerId)) return account;
	}
	return undefined;
}

function updateAccountStatus(ctx: ExtensionContext, providerId?: string): void {
	const account = providerId ? accountForProvider(providerId) : undefined;
	ctx.ui.setStatus("auth-account", account ? `account: ${account}` : undefined);
}

async function selectAuthType(ctx: ExtensionCommandContext, provider?: Provider<Api>): Promise<"oauth" | "api_key" | undefined> {
	const types = provider ? providerAuthTypes(provider) : (["oauth", "api_key"] as const).filter((type) => baseProviders(ctx, type).length > 0);
	if (types.length === 0) return undefined;
	if (types.length === 1) return types[0];
	const labels = types.map(authTypeLabel);
	const choice = await ctx.ui.select("Select authentication method", labels);
	return choice ? types[labels.indexOf(choice)] : undefined;
}

async function selectProvider(ctx: ExtensionCommandContext, authType: "oauth" | "api_key", providerRef?: string): Promise<Provider<Api> | undefined> {
	const providers = baseProviders(ctx, authType);
	if (providerRef) {
		const normalized = providerRef.toLowerCase();
		const exact = providers.find((provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized);
		if (exact) return exact;
	}
	if (providers.length === 0) return undefined;
	if (providers.length === 1) return providers[0];
	const labels = providers.map((provider) => `${provider.name} (${provider.id})`);
	const choice = await ctx.ui.select("Select provider", labels);
	return choice ? providers[labels.indexOf(choice)] : undefined;
}

async function showAuthPrompt(ctx: ExtensionCommandContext, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const labels = prompt.options.map((option) => option.label);
		const choice = await ctx.ui.select(prompt.message, labels);
		const id = choice ? prompt.options.find((option) => option.label === choice)?.id : undefined;
		if (!id) throw new Error("Login cancelled");
		return id;
	}
	return await ctx.ui.input(prompt.message, "placeholder" in prompt ? prompt.placeholder : undefined) ?? "";
}

function notifyAuth(ctx: ExtensionCommandContext, event: AuthEvent): void {
	if (event.type === "auth_url") ctx.ui.notify(`${event.instructions ? `${event.instructions}\n\n` : ""}${event.url}`, "info");
	else if (event.type === "device_code") ctx.ui.notify(`${event.verificationUri}\n\nCode: ${event.userCode}`, "info");
	else if (event.type === "info") ctx.ui.notify(event.message, "info");
	else ctx.ui.notify(event.message, "info");
}

async function loginAliasProvider(ctx: ExtensionCommandContext, providerId: string, providerName: string, authType: "oauth" | "api_key"): Promise<void> {
	if (ctx.mode === "tui") {
		// Use pi's login component as a live progress surface; prompts still use ctx.ui helpers.
		let loginError: unknown;
		await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
			const dialog = new LoginDialogComponent(tui, providerId, () => {}, providerName);
			void runtime(ctx).login(providerId, authType, {
				signal: dialog.signal,
				prompt: async (prompt: AuthPrompt) => {
					if (prompt.type === "manual_code") return dialog.showManualInput(prompt.message);
					if (prompt.type === "select") return showAuthPrompt(ctx, prompt);
					return dialog.showPrompt(prompt.message, "placeholder" in prompt ? prompt.placeholder : undefined);
				},
				notify: (event: AuthEvent) => {
					if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
					else if (event.type === "device_code") { dialog.showDeviceCode(event); dialog.showWaiting("Waiting for authentication..."); }
					else if (event.type === "info") dialog.showInfo(event.message, event.links);
					else dialog.showProgress(event.message);
				},
			}).then(() => done()).catch((error: unknown) => {
				loginError = error;
				done();
			});
			return dialog;
		});
		if (loginError) throw loginError;
		return;
	}
	await runtime(ctx).login(providerId, authType, {
		prompt: (prompt: AuthPrompt) => showAuthPrompt(ctx, prompt),
		notify: (event: AuthEvent) => notifyAuth(ctx, event),
	});
}

async function chooseCredentialLabel(ctx: ExtensionCommandContext, account: string, baseProviderId: string, authType: "oauth" | "api_key"): Promise<string | undefined> {
	const store = readStore();
	const existing = (store.providers[account] ?? []).filter((provider) => provider.baseProviderId === baseProviderId && provider.authType === authType);
	if (existing.length === 0) return undefined;
	return (await ctx.ui.input(`Label this ${baseProviderId} credential in ${account}`, `${authType === "oauth" ? "login" : "key"}-${existing.length + 1}`))?.trim() || undefined;
}

function completionItem(value: string, description?: string) {
	return { value, label: value, ...(description ? { description } : {}) };
}

function accountCompletions(argumentPrefix: string) {
	const input = argumentPrefix.trimStart();
	const endsWithSpace = input.endsWith(" ");
	const parts = input.split(/\s+/).filter(Boolean);
	const subcommands = [
		["login", "Add a provider login/API key to an account"],
		["add", "Create an empty account profile"],
		["list", "List accounts and provider logins"],
		["remove", "Delete an account profile"],
	] as const;
	if (parts.length === 0 || (!endsWithSpace && parts.length === 1)) {
		const query = parts[0] ?? "";
		return subcommands.filter(([name]) => name.startsWith(query)).map(([name, description]) => completionItem(`${name} `, description));
	}
	const subcommand = parts[0];
	const argIndex = endsWithSpace ? parts.length : parts.length - 1;
	const query = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
	if ((subcommand === "login" || subcommand === "remove") && argIndex === 1) {
		return readStore().profiles.filter((name) => name.startsWith(query)).map((name) => completionItem(`${subcommand} ${name}`));
	}
	return null;
}

function usage(): string {
	return [
		"Usage:",
		"  /account login [name] [provider] add a provider login/API key to an account",
		"  /account add [name]              create an empty account profile",
		"  /account list                    show accounts and provider logins",
		"  /account remove <name>           delete an account profile metadata",
		"",
		"Accounts are scopes containing one or more provider logins. Credentials are stored by pi under account-specific provider ids, so normal provider login/refresh behavior is preserved.",
	].join("\n");
}

export default function extension(pi: ExtensionAPI) {
	// Register aliases during extension load so startup model resolution sees them.
	// The session_start path below refreshes them against the live registry and
	// also handles aliases for providers registered by other extensions.
	registerBuiltinAccountProviders(pi);

	pi.on("session_start", (_event, ctx) => {
		registerAccountProviders(ctx);
		updateAccountStatus(ctx, ctx.model?.provider);
	});

	pi.on("model_select", (event, ctx) => {
		updateAccountStatus(ctx, event.model.provider);
	});

	pi.registerCommand("account", {
		description: "Create, list, and remove named account logins",
		getArgumentCompletions: accountCompletions,
		handler: async (args, ctx) => {
			const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const store = readStore();

			if (subcommand === "add") {
				let label = rest[0];
				if (!label && ctx.hasUI) label = await ctx.ui.input("Account name", "work");
				if (!label) return ctx.ui.notify(usage(), "error");
				if (!store.profiles.includes(label)) store.profiles.push(label);
				store.providers[label] ??= [];
				writeStore(store);
				ctx.ui.notify(`Created account "${label}". Use /account login ${label} to add a provider.`, "info");
				return;
			}

			if (subcommand === "login") {
				let account = rest[0];
				const providerRef = rest[1];
				if (!account && ctx.hasUI) account = await ctx.ui.input("Account name", "work");
				if (!account) return ctx.ui.notify("Usage: /account login <account> [provider]", "error");
				if (!store.profiles.includes(account)) store.profiles.push(account);
				store.providers[account] ??= [];
				writeStore(store);

				let selectedProvider = providerRef ? baseProviders(ctx).find((provider) => provider.id === providerRef || provider.name.toLowerCase() === providerRef.toLowerCase()) : undefined;
				const authType = await selectAuthType(ctx, selectedProvider);
				if (!authType) return ctx.ui.notify("No login methods available.", "error");
				selectedProvider = selectedProvider ?? await selectProvider(ctx, authType, providerRef);
				if (!selectedProvider) return ctx.ui.notify("No provider selected.", "error");

				const label = await chooseCredentialLabel(ctx, account, selectedProvider.id, authType);
				const providerId = aliasProviderId(selectedProvider.id, account, label);
				const entry: AccountProvider = { providerId, baseProviderId: selectedProvider.id, authType, ...(label ? { label } : {}) };
				cloneProviderForAccount(ctx, account, entry);
				await loginAliasProvider(ctx, providerId, `${selectedProvider.name} (${account}${label ? ` · ${label}` : ""})`, authType);
				await ctx.modelRegistry.refresh({ providers: [providerId] }).catch(() => undefined);

				const updated = readStore();
				if (!updated.profiles.includes(account)) updated.profiles.push(account);
				updated.providers[account] = dedupeProviders([...(updated.providers[account] ?? []), entry]);
				writeStore(updated);
				ctx.ui.notify(`Added ${authTypeLabel(authType)} login for ${selectedProvider.name} to account "${account}" as ${providerId}.`, "info");
				return;
			}

			if (subcommand === "list") {
				if (store.profiles.length === 0) return ctx.ui.notify("No accounts configured.", "info");
				const lines = store.profiles.map((name) => {
					const providers = store.providers[name] ?? [];
					return `${name}${providers.length > 0 ? `\n  ${providers.map((p) => `${p.providerId} (${authTypeLabel(p.authType)} → ${p.baseProviderId})`).join("\n  ")}` : "\n  (no provider logins)"}`;
				});
				ctx.ui.notify(`Accounts:\n${lines.join("\n")}`, "info");
				return;
			}

			if (subcommand === "remove") {
				const account = rest[0];
				if (!account) return ctx.ui.notify("Usage: /account remove <name>", "error");
				if (!store.profiles.includes(account)) return ctx.ui.notify(`No account named "${account}".`, "error");
				for (const provider of store.providers[account] ?? []) ctx.modelRegistry.unregisterProvider(provider.providerId);
				store.profiles = store.profiles.filter((name) => name !== account);
				delete store.providers[account];
				writeStore(store);
				ctx.ui.notify(`Removed account "${account}". Stored credentials for its provider IDs were left untouched; use /logout to remove credentials.`, "info");
				return;
			}

			ctx.ui.notify(usage(), "error");
		},
	});
}
