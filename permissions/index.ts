/**
 * Entry point for pi's extension discovery (~/.pi/agent/extensions/*_/index.ts).
 * The implementation lives under src/ so the pieces can be imported directly —
 * subagents/index.ts loads src/extension.ts by path into child sessions.
 */
export { default } from "./src/extension.ts";
