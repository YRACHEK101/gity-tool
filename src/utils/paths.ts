/**
 * Cross-platform path helpers.
 *
 * Git stores paths inside its config using forward slashes on every OS
 * (including Windows), and understands a leading `~` for the home directory.
 * These helpers keep all path handling in one place so the rest of the tool
 * never has to think about `\` vs `/` or how to expand `~`.
 */
import os from "node:os";
import path from "node:path";

/**
 * Expand a leading `~` (or `~/`, `~\`) into the user's home directory.
 * Anything that does not start with `~` is returned unchanged.
 */
export function expandHome(input: string, home = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** Expand `~` and resolve to an absolute, OS-native path. */
export function toAbsolute(input: string, home = os.homedir()): string {
  return path.resolve(expandHome(input, home));
}

/** Convert any backslashes to forward slashes (the form Git stores on disk). */
export function toGitPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Collapse the home-directory prefix back into `~` and use forward slashes.
 * Produces the portable, human-friendly form Git understands in its config,
 * e.g. `/Users/alice/dev` -> `~/dev`, `C:\Users\alice\dev` -> `~/dev`.
 */
export function tildify(absPath: string, home = os.homedir()): string {
  const norm = toGitPath(absPath);
  const homeNorm = toGitPath(home);
  if (norm.toLowerCase() === homeNorm.toLowerCase()) return "~";
  if (norm.toLowerCase().startsWith(homeNorm.toLowerCase() + "/")) {
    return "~" + norm.slice(homeNorm.length);
  }
  return norm;
}

/**
 * Build the directory pattern used by Git's `includeIf "gitdir:..."`.
 * The path is resolved, tildified and guaranteed to end with a single `/`
 * (Git treats a trailing slash as "everything inside this directory").
 */
export function toGitdirPattern(input: string, home = os.homedir()): string {
  const abs = toAbsolute(input, home);
  let pattern = tildify(abs, home);
  if (!pattern.endsWith("/")) pattern += "/";
  return pattern;
}

/** A slug is safe to embed in a filename: letters, digits, dot, dash, underscore. */
export function isValidProfileName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/** Very small, permissive email sanity check (not RFC-complete on purpose). */
export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
