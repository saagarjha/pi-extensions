import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	InteractiveMode,
	getPackageDir,
	type AgentSessionEvent,
	type AgentSession,
	type SessionManager,
	type SessionEntry,
	type SettingsManager,
	type ExtensionUIContext,
	type MessageRenderer,
	type EntryRenderer,
	type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "../shared/tool-renderers.ts";
import { messageProvenance, userMessageDisplayText } from "./messaging.ts";
import { notifyParentRenderers } from "./notify-parent-renderer.ts";

type Message = AgentSession["messages"][number];
type NativeMethod = (this: object, ...args: any[]) => any;
const native = InteractiveMode.prototype as unknown as Record<string, NativeMethod>;
const methods = new Set([
	"renderSessionEntries",
	"renderSessionItems",
	"addMessageToChat",
	"addCustomEntryToChat",
	"getUserMessageText",
	"getRegisteredToolDefinition",
	"getMarkdownThemeWithSettings",
	"getMarkdownTransformers",
	"maybeShowThinkingDropNotice",
	"maybeShowCacheMissNotice",
	"addCacheWarmingUsage",
	"addCompactionCostNotice",
	"addCacheMissNotice",
]);
const events = new Set([
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"entry_appended",
	"agent_start",
	"agent_end",
]);
const settingsNames = [
	"getCodeBlockIndent",
	"getShowImages",
	"getImageWidthCells",
	"getMermaidRenderingMode",
] as const;
export interface NativeTranscriptOptions {
	tui: TUI;
	theme: ExtensionUIContext["theme"];
	settings: SettingsManager;
	manager: SessionManager;
	toolRenderer(name: string): ToolRenderers | undefined;
	messageRenderer(name: string): MessageRenderer | undefined;
	entryRenderer(name: string): EntryRenderer | undefined;
	markdownTransformers(): MarkdownTransformer[];
	expanded: boolean;
	hideThinking: boolean;
	retryAttempt?: number;
	changed(): void;
}
let mermaidFactory: Promise<(options: unknown) => MarkdownTransformer> | undefined;
async function loadMermaid() {
	return (mermaidFactory ??= import(
		pathToFileURL(join(getPackageDir(), "dist/modes/interactive/components/mermaid.js")).href
	).then((module) => {
		if (typeof module.createMermaidMarkdownTransformer !== "function")
			throw Error("Native Mermaid factory export missing");
		return module.createMermaidMarkdownTransformer;
	}));
}
function restricted<T extends object>(name: string, value: T): T {
	return new Proxy(value, {
		get(target, key) {
			if (Object.hasOwn(target, key)) return Reflect.get(target, key);
			throw Error(`Unsupported native transcript capability: ${name}.${String(key)}`);
		},
		set(_target, key) {
			throw Error(`Native transcript cannot mutate ${name}.${String(key)}`);
		},
	});
}

function contextReader(manager: SessionManager) {
	return restricted("sessionManager", {
		getCwd: manager.getCwd.bind(manager),
		getEntries: manager.getEntries.bind(manager),
		getBranch: manager.getBranch.bind(manager),
		buildContextEntries: manager.buildContextEntries.bind(manager),
	});
}
type RenderGate = { generation: number; tui?: TUI; changed?: () => void };
function renderTarget(gate: RenderGate) {
	const generation = gate.generation;
	return restricted("ui", {
		terminal: restricted("terminal", {
			get columns() {
				return gate.tui?.terminal.columns ?? 80;
			},
			get rows() {
				return gate.tui?.terminal.rows ?? 24;
			},
		}),
		requestRender() {
			if (gate.generation === generation) gate.changed?.();
		},
	});
}

/** Installed SDK rendering bodies, scoped to a presentation-only receiver. No
 * mode/session constructor, parent field swap, tool pairing, or operational fallback. */
export class NativeTranscript {
	readonly container = new Container();
	private alive = true;
	// One boundary per native displayed message, never one per layout component.
	private messageEnds: (Component | undefined)[] = [];
	private streamingGroup?: { component: Component; end: Component; index: number };
	private assembly = false;
	private countCache?: WeakMap<Component, number>;
	private recordMessage(start: number, assistant = false) {
		const children = this.container.children;
		// Native assistants may allocate an empty content container before any
		// text/thinking arrives. Inspect its assembled children, never lay it out.
		const body = children[start] as Component & { contentContainer: Container };
		if (children.length === start + 1 && assistant && !body.contentContainer.children.length) return;
		if (children.length > start) {
			this.messageEnds.push(children.at(-1)!);
			this.countCache = undefined;
		}
	}
	/** Fully hidden messages only: a partially visible message (including its
	 * native inline tool output) is not earlier. No rendering/measurement here. */
	earlierMessages(first?: Component): number {
		if (!first) return 0;
		if (!this.countCache) {
			const ends = new Set(this.messageEnds);
			this.countCache = new WeakMap();
			let count = 0;
			for (const component of this.container.children) {
				this.countCache.set(component, count);
				if (ends.has(component)) count++;
			}
			// The container marks the boundary after all native messages, for
			// trailing panel-only UI such as a scrollable notification.
			this.countCache.set(this.container, count);
		}
		return this.countCache.get(first) ?? 0;
	}
	private gate: RenderGate;
	private receiver: Record<string, any>;
	private state: Record<string, any>;
	private constructor(
		private options: NativeTranscriptOptions,
		mermaid: MarkdownTransformer,
	) {
		const settings = restricted("settings", {
			...Object.fromEntries(
				settingsNames.map((name) => [
					name,
					(...args: unknown[]) => Reflect.apply(options.settings[name], options.settings, args),
				]),
			),
			// These parent-only notices/progress were not part of the embedded console.
			getShowCacheMissNotices: () => false,
			getShowTerminalProgress: () => false,
		});
		this.gate = { generation: 0, tui: options.tui, changed: options.changed };
		this.state = {
			chatContainer: this.container,
			pendingTools: new Map(),
			// Native entry_appended rendering consumes IDs already drawn by a
			// boundary-compaction rebuild. This belongs to this receiver, not the session.
			entriesRenderedByBoundaryCompaction: new Set<string>(),
			streamingComponent: undefined,
			streamingMessage: undefined,
			isInitialized: true,
			retryEscapeHandler: undefined,
			toolOutputExpanded: options.expanded,
			hideThinkingBlock: options.hideThinking,
			hiddenThinkingLabel: undefined,
			outputPad: options.settings.getOutputPad(),
			settingsManager: settings,
			sessionManager: contextReader(options.manager),
			ui: renderTarget(this.gate),
			mermaidMarkdownTransformer: mermaid,
			session: restricted("session", {
				get retryAttempt() {
					return options.retryAttempt ?? 0;
				},
				getToolDefinition: (name: string) => {
					const definition = options.toolRenderer(name);
					return name === "notify_parent"
						? { ...definition, renderCall: definition?.renderCall ?? notifyParentRenderers.renderCall }
						: definition;
				},
				extensionRunner: restricted("extensionRunner", {
					getMessageRenderer: options.messageRenderer,
					getEntryRenderer: options.entryRenderer,
					getMarkdownTransformers: options.markdownTransformers,
				}),
			}),
			footer: restricted("footer", { invalidate() {} }),
			updatePendingMessagesDisplay() {},
			clearStatusIndicator() {},
			suggestBugReport() {},
			// Only our provenance decoration differs; native methods still own all
			// role dispatch, skills, message components and tool/result assembly.
			getUserMessageText: (message: Message) => userMessageDisplayText(message),
			addMessageToChat: (message: Message, ...args: unknown[]) => {
				const start = this.container.children.length;
				const result = native.addMessageToChat!.call(this.receiver, message, ...args);
				const origin = messageProvenance(message)?.origin;
				// Native assembly owns the leading message separator. Decorate after
				// it, so no external blank row splits the label from its message.
				if (origin && this.container.children.length > start)
					this.container.children.splice(
						start + (this.container.children[start] instanceof Spacer ? 1 : 0),
						0,
						new Text(
							options.theme.fg(
								"dim",
								origin === "user" ? "User" : origin === "parent" ? "Parent" : "Extension",
							),
							0,
							0,
						),
					);
				if (!this.assembly) {
					this.recordMessage(start, message.role === "assistant");
					if (this.container.children.length > start && message.role !== "assistant")
						this.streamingGroup = undefined;
				}
				return result;
			},
		};
		// Observe the original loop's item boundaries, retaining its complete native
		// tool/result pairing and component assembly in one invocation.
		this.state.renderSessionItems = (items: Iterable<any>, ...args: unknown[]) => {
			const self = this;
			function* observed() {
				for (const item of items) {
					const start = self.container.children.length;
					yield item;
					if (typeof item.role === "string") self.recordMessage(start, item.role === "assistant");
				}
			}
			this.assembly = true;
			try { return native.renderSessionItems!.call(this.receiver, observed(), ...args); }
			finally { this.assembly = false; }
		};
		const bound = new Map<string, NativeMethod>();
		this.receiver = new Proxy(this.state, {
			get(target, key) {
				if (Object.hasOwn(target, key)) return Reflect.get(target, key);
				if (typeof key === "string" && methods.has(key)) {
					if (!bound.has(key)) {
						if (typeof native[key] !== "function")
							throw Error(`Native transcript SDK seam missing: ${key}`);
						bound.set(key, native[key]!.bind(receiver));
					}
					return bound.get(key);
				}
				throw Error(`Unsupported native transcript capability: ${String(key)}`);
			},
			set(target, key, value) {
				if (key !== "streamingComponent" && key !== "streamingMessage")
					throw Error(`Unsupported native transcript mutation: ${String(key)}`);
				Reflect.set(target, key, value);
				return true;
			},
		});
		const receiver = this.receiver;
	}
	static async factory(warn: (message: string) => void = console.warn) {
		let createMermaid: Awaited<ReturnType<typeof loadMermaid>> | undefined;
		const unavailable = (error: unknown) =>
			warn(`Child Mermaid rendering disabled; showing source: ${String(error)}`);
		try {
			createMermaid = await loadMermaid();
		} catch (error) {
			unavailable(error);
		}
		return (options: NativeTranscriptOptions) => {
			let transformer: MarkdownTransformer | undefined;
			try {
				if (createMermaid)
					transformer = createMermaid({
						getMode: () => options.settings.getMermaidRenderingMode(),
						theme: options.theme,
					});
			} catch (error) {
				unavailable(error);
			}
			return new NativeTranscript(options, (markdown, context) => {
				if (transformer) {
					try {
						return transformer(markdown, context);
					} catch (error) {
						transformer = undefined;
						unavailable(error);
					}
				}
				return markdown;
			});
		};
	}
	static async create(options: NativeTranscriptOptions): Promise<NativeTranscript> {
		return (await this.factory())(options);
	}
	reset(manager = this.options.manager) {
		if (!this.alive) throw Error("Native transcript retired");
		this.options.manager = manager;
		this.state.sessionManager = contextReader(manager);
		this.gate.generation++;
		this.state.ui = renderTarget(this.gate);
		this.state.streamingComponent = this.state.streamingMessage = undefined;
		this.state.entriesRenderedByBoundaryCompaction.clear();
		this.container.clear();
		this.messageEnds = [];
		this.streamingGroup = undefined;
		this.countCache = undefined;
		this.receiver.renderSessionEntries(manager.buildContextEntries());
	}
	async event(event: AgentSessionEvent) {
		if (!this.alive) return;
		if (!events.has(event.type)) return false;
		const start = this.container.children.length;
		const pending = native.handleEvent!.call(this.receiver, structuredClone(event));
		// Admitted native presentation branches are synchronous before returning.
		if (event.type === "message_start" && event.message.role === "assistant") {
			const component = this.state.streamingComponent as Component;
			this.streamingGroup = { component, end: component, index: -1 };
		}
		const group = this.streamingGroup;
		if (group &&
			((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant" || event.type === "tool_execution_start")) {
			if (this.container.children.length > start) group.end = this.container.children.at(-1)!;
			const body = group.component as Component & { contentContainer: Container };
			const displayed = group.end !== group.component || body.contentContainer.children.length > 0;
			if (group.index < 0 && displayed) {
				group.index = this.messageEnds.length;
				this.messageEnds.push(group.end);
				this.countCache = undefined;
			} else if (group.index >= 0) {
				const end = displayed ? group.end : undefined;
				if (this.messageEnds[group.index] !== end) this.countCache = undefined;
				this.messageEnds[group.index] = end;
			}
		}
		if (event.type === "agent_end" || event.type === "agent_start") this.streamingGroup = undefined;
		if (this.container.children.length !== start) this.countCache = undefined;
		await pending;
		return true;
	}
	hydrate(
		partial?: Message | null,
		tools: readonly {
			start: AgentSessionEvent;
			update?: AgentSessionEvent;
			end?: AgentSessionEvent;
		}[] = [],
	) {
		// The admitted native branches execute synchronously (only initialization
		// and operational branches await). Do not yield between bootstrap events.
		const pending: Promise<unknown>[] = [];
		// An observation can straddle final persistence. The native context may
		// already contain this assistant; never add a second bootstrap component.
		const last = partial ? this.options.manager.buildSessionContext().messages.at(-1) : undefined;
		const committed =
			partial?.role === "assistant" &&
			last?.role === "assistant" &&
			last.timestamp === partial.timestamp;
		if (partial && !committed) {
			pending.push(this.event({ type: "message_start", message: partial }));
			pending.push(this.event({ type: "message_update", message: partial } as AgentSessionEvent));
		}
		for (const tool of tools) {
			// Consult native pending state, never implement another pairing algorithm.
			if (tool.end && !this.state.pendingTools.has((tool.start as any).toolCallId)) continue;
			pending.push(this.event(tool.start));
			if (tool.update) pending.push(this.event(tool.update));
			if (tool.end) pending.push(this.event(tool.end));
		}
		return Promise.all(pending);
	}
	/** Bash results are persisted without a native message_start event (the main
	 * mode normally draws them in its command callback). Delegate this transport
	 * gap to the original message renderer, not an app component implementation. */
	committed(entry: SessionEntry) {
		if (this.alive && entry.type === "message" && entry.message.role === "bashExecution") {
			this.receiver.addMessageToChat(entry.message);
			this.options.changed();
		}
	}
	setRetryAttempt(attempt: number) {
		this.options.retryAttempt = attempt;
	}
	setOptions(expanded: boolean, hideThinking: boolean) {
		this.state.toolOutputExpanded = expanded;
		this.state.hideThinkingBlock = hideThinking;
		// Component capabilities, not roles or tool IDs. Native components own the updates.
		for (const component of this.container.children) {
			const adjustable = component as typeof component & {
				setExpanded?(value: boolean): void;
				setHideThinkingBlock?(value: boolean): void;
			};
			adjustable.setExpanded?.(expanded);
			adjustable.setHideThinkingBlock?.(hideThinking);
		}
		this.options.changed();
	}
	invalidate() {
		this.container.invalidate();
	}
	dispose() {
		this.alive = false;
		this.gate.generation++;
		this.gate.changed = undefined;
		this.gate.tui = undefined;
		this.container.clear();
		this.state.pendingTools.clear();
		this.state.entriesRenderedByBoundaryCompaction.clear();
		this.messageEnds = [];
		this.streamingGroup = undefined;
		this.countCache = undefined;
		this.state.streamingComponent = this.state.streamingMessage = undefined;
	}
}
