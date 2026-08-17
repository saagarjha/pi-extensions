import { realpathSync } from "node:fs";

/**
 * Path handling for the permission layer.
 *
 * Normalize to NFC at both ends. Pi's own resolver (path-utils.ts) will try NFD
 * variants of a path and open whichever exists, so a grant recorded in one form
 * and a path opened in the other will not compare equal unless we pin the form.
 */

export function nfc(p: string): string {
	return p.normalize("NFC");
}

/** Non-empty path segments, NFC-normalized. */
export function segments(p: string): string[] {
	return nfc(p)
		.split("/")
		.filter((s) => s.length > 0);
}

/**
 * True when `parent` is an ancestor of, or equal to, `child`.
 *
 * Compares segments rather than string prefixes on purpose: "/srcfoo" must not
 * be considered inside "/src". That bug fails open, so it gets its own function
 * and its own tests.
 */
export function isUnder(child: string, parent: string): boolean {
	const c = segments(child);
	const p = segments(parent);
	if (p.length > c.length) return false;
	for (let i = 0; i < p.length; i++) {
		if (c[i] !== p[i]) return false;
	}
	return true;
}

/** How many segments deep a path is; used to pick the most specific scope. */
export function depth(p: string): number {
	return segments(p).length;
}

/**
 * Fully resolve a path, following every symlink, normalized to NFC.
 *
 * FIXME(toctou): this returns a *name*, not a handle. Callers resolve, check
 * containment, then open — and the open re-walks the name from the root. A
 * directory component swapped for a symlink in between redirects the read:
 *
 *     real = realpath(p)        // "/scope/sub/file", no symlinks in it
 *     check(real)               // passes
 *        <-- `sub` becomes a symlink to /etc
 *     readFile(real)            // kernel re-walks the name, follows it
 *
 * O_NOFOLLOW does not help: it only refuses a symlink as the *final* component,
 * and this attack is on a directory component. Closing it properly needs either
 * openat2(RESOLVE_NO_SYMLINKS) or a component-wise openat walk, neither of which
 * Node binds — or the ordering fix: open first, then realpath, then compare
 * (dev, ino) to prove the descriptor is the object you resolved, and only then
 * check containment.
 *
 * Accepted for now. Exploiting it needs a writable scope plus concurrent
 * execution to race two syscalls, and the real boundary is the kernel-enforced
 * mount inside the VM rather than this check.
 */
export function resolveReal(path: string): string {
	return nfc(realpathSync(path));
}
