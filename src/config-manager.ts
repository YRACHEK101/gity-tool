/**
 * Reads and (safely, non-destructively) writes Git configuration so that
 * `gity` can wire up multiple identities using Git's native conditional
 * includes (`includeIf "gitdir:..."`).
 *
 * Nothing here ever rewrites or deletes an existing user section — the global
 * config is only ever *appended* to, and only when the exact include is not
 * already present (so re-running is idempotent).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expandHome,
  toAbsolute,
  toGitdirPattern,
  tildify,
} from "./utils/paths.js";

/** What the user supplies when adding a profile. */
export interface ProfileInput {
  name: string;
  fullName: string;
  email: string;
  dir: string; // raw path, may contain `~`
  sshKeyPath?: string; // raw path, may contain `~`
}

/** A fully-resolved profile with all paths made absolute. */
export interface Profile {
  name: string;
  fullName: string;
  email: string;
  dir: string; // absolute
  gitdirPattern: string; // e.g. `~/dev/work/`
  sshKeyPath: string; // absolute private-key path
  subConfigPath: string; // absolute ~/.gitconfig-<name>
}

/** A discovered profile, reconstructed from files on disk. */
export interface ProfileSummary {
  name: string;
  fullName?: string;
  email?: string;
  dir?: string; // display form (from the includeIf), e.g. `~/dev/work/`
  sshKeyPath?: string; // absolute
  keyExists: boolean;
  subConfigPath: string;
}

export interface Paths {
  /** Home directory (injectable for tests). */
  home?: string;
  /** Path to the global git config (defaults to $GIT_CONFIG_GLOBAL or ~/.gitconfig). */
  globalConfigPath?: string;
}

function resolveHome(opts: Paths = {}): string {
  return opts.home ?? os.homedir();
}

/** Location of the global git config. Honours $GIT_CONFIG_GLOBAL when set. */
export function globalConfigPath(opts: Paths = {}): string {
  if (opts.globalConfigPath) return opts.globalConfigPath;
  if (process.env.GIT_CONFIG_GLOBAL) return process.env.GIT_CONFIG_GLOBAL;
  return path.join(resolveHome(opts), ".gitconfig");
}

/** Path to a profile's dedicated sub-config: ~/.gitconfig-<name>. */
export function subConfigPath(name: string, opts: Paths = {}): string {
  return path.join(resolveHome(opts), `.gitconfig-${name}`);
}

/** Default private-key path for a profile: ~/.ssh/id_ed25519_<name>. */
export function defaultKeyPath(name: string, opts: Paths = {}): string {
  return path.join(resolveHome(opts), ".ssh", `id_ed25519_${name}`);
}

/** Resolve raw user input into a fully-qualified {@link Profile}. */
export function makeProfile(input: ProfileInput, opts: Paths = {}): Profile {
  const home = resolveHome(opts);
  const sshKeyPath = input.sshKeyPath
    ? toAbsolute(input.sshKeyPath, home)
    : defaultKeyPath(input.name, opts);
  return {
    name: input.name,
    fullName: input.fullName,
    email: input.email,
    dir: toAbsolute(input.dir, home),
    gitdirPattern: toGitdirPattern(input.dir, home),
    sshKeyPath,
    subConfigPath: subConfigPath(input.name, opts),
  };
}

// ---------------------------------------------------------------------------
// Tiny git-config (INI) reader — just enough for our needs.
// ---------------------------------------------------------------------------

export interface IniEntry {
  section: string; // lower-cased, e.g. "user", "includeif"
  subsection?: string; // verbatim, e.g. `gitdir:~/dev/work/`
  key: string; // lower-cased
  value: string;
}

/** Parse git-config text into a flat list of entries. */
export function parseGitConfig(content: string): IniEntry[] {
  const out: IniEntry[] = [];
  let section = "";
  let subsection: string | undefined;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const header = line.match(/^\[([^\s"\]]+)(?:\s+"(.*)")?\]$/);
    if (header) {
      section = header[1].toLowerCase();
      subsection = header[2];
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      out.push({ section, subsection, key: line.toLowerCase(), value: "true" });
      continue;
    }

    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out.push({ section, subsection, key, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** The `includeIf` block appended to the global config. */
export function buildIncludeBlock(gitdirPattern: string, subConfigDisplay: string): string {
  return `[includeIf "gitdir:${gitdirPattern}"]\n\tpath = ${subConfigDisplay}\n`;
}

/** The full contents of a per-profile sub-config file. */
export function buildSubConfig(profile: Profile, home = os.homedir()): string {
  const keyDisplay = tildify(profile.sshKeyPath, home);
  return [
    `# Managed by gity — profile "${profile.name}"`,
    "[user]",
    `\tname = ${profile.fullName}`,
    `\temail = ${profile.email}`,
    "[core]",
    `\tsshCommand = "ssh -i ${keyDisplay} -o IdentitiesOnly=yes"`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mutations (non-destructive)
// ---------------------------------------------------------------------------

/** True if an include for this gitdir pattern already exists in `content`. */
export function hasIncludeFor(content: string, gitdirPattern: string): boolean {
  const target = `gitdir:${gitdirPattern}`.toLowerCase();
  return parseGitConfig(content).some(
    (e) => e.section === "includeif" && (e.subsection ?? "").toLowerCase() === target
  );
}

/**
 * Append the `includeIf` block to the global config if it is not already
 * present. Returns true if the block was added, false if it already existed.
 * The existing file is never rewritten — only appended to.
 */
export function ensureInclude(profile: Profile, opts: Paths = {}): boolean {
  const home = resolveHome(opts);
  const gPath = globalConfigPath(opts);
  const content = fs.existsSync(gPath) ? fs.readFileSync(gPath, "utf8") : "";

  if (hasIncludeFor(content, profile.gitdirPattern)) return false;

  const subDisplay = tildify(profile.subConfigPath, home);
  const block = buildIncludeBlock(profile.gitdirPattern, subDisplay);

  const base = content.length === 0 || content.endsWith("\n") ? content : content + "\n";
  const sep = base.length === 0 ? "" : "\n"; // blank line before our block
  fs.writeFileSync(gPath, base + sep + block, "utf8");
  return true;
}

/** True if the profile's sub-config file already exists on disk. */
export function subConfigExists(name: string, opts: Paths = {}): boolean {
  return fs.existsSync(subConfigPath(name, opts));
}

/** Write the per-profile sub-config file. */
export function writeSubConfig(profile: Profile, opts: Paths = {}): void {
  fs.writeFileSync(profile.subConfigPath, buildSubConfig(profile, resolveHome(opts)), "utf8");
}

export interface AddResult {
  profile: Profile;
  globalConfigPath: string;
  includeAdded: boolean; // false when the include was already present
}

/**
 * Wire up a profile end-to-end (sub-config + global include). Does NOT touch
 * SSH keys — that is the SSH manager's job, kept separate on purpose.
 */
export function addProfile(input: ProfileInput, opts: Paths = {}): AddResult {
  const profile = makeProfile(input, opts);
  writeSubConfig(profile, opts);
  const includeAdded = ensureInclude(profile, opts);
  return { profile, globalConfigPath: globalConfigPath(opts), includeAdded };
}

// ---------------------------------------------------------------------------
// Discovery / listing
// ---------------------------------------------------------------------------

/** Pull the `-i <path>` argument out of a `core.sshCommand` string. */
export function extractKeyPath(sshCommand: string): string | undefined {
  const m = sshCommand.match(/-i\s+(?:"([^"]+)"|(\S+))/);
  const raw = m?.[1] ?? m?.[2];
  return raw ? expandHome(raw) : undefined;
}

/**
 * Discover all gity-managed profiles by scanning for `~/.gitconfig-*` files
 * and cross-referencing the global config for their mapped directories.
 */
export function listProfiles(opts: Paths = {}): ProfileSummary[] {
  const home = resolveHome(opts);

  // Map each included sub-config path -> its gitdir pattern.
  const gPath = globalConfigPath(opts);
  const includeMap = new Map<string, string>();
  if (fs.existsSync(gPath)) {
    const entries = parseGitConfig(fs.readFileSync(gPath, "utf8"));
    for (const e of entries) {
      if (e.section === "includeif" && e.key === "path" && e.subsection?.startsWith("gitdir:")) {
        const resolved = toAbsolute(e.value, home).toLowerCase();
        includeMap.set(resolved, e.subsection.slice("gitdir:".length));
      }
    }
  }

  if (!fs.existsSync(home)) return [];
  const files = fs
    .readdirSync(home)
    .map((f) => f.match(/^\.gitconfig-(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null);

  const summaries: ProfileSummary[] = files.map((m) => {
    const name = m[1];
    const file = path.join(home, m[0]);
    const entries = parseGitConfig(fs.readFileSync(file, "utf8"));

    const get = (section: string, key: string) =>
      entries.find((e) => e.section === section && e.key === key)?.value;

    const sshCommand = get("core", "sshcommand");
    const keyPath = sshCommand ? extractKeyPath(sshCommand) : undefined;

    return {
      name,
      fullName: get("user", "name"),
      email: get("user", "email"),
      dir: includeMap.get(file.toLowerCase()),
      sshKeyPath: keyPath,
      keyExists: keyPath ? fs.existsSync(keyPath) : false,
      subConfigPath: file,
    };
  });

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}
