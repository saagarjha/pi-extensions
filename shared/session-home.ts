import { homedir } from "node:os";

/** Owned daemon and child sessions use the host's HOME; this is not tool cwd policy. */
export const sessionHome = () => homedir();
