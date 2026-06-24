/**
 * Thin, safe wrapper around the system `ssh-keygen` / `ssh` binaries.
 *
 * Every external process is spawned with an explicit argument array (never a
 * shell string), so user-supplied values like emails or paths can never be
 * interpreted as shell syntax. Missing binaries are reported as typed errors
 * instead of crashing the runtime, so the CLI can guide the user instead.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Thrown when `ssh-keygen` / `ssh` is not found on PATH (e.g. bare Windows). */
export class SshBinaryNotFoundError extends Error {
  constructor(public readonly binary: string) {
    super(
      `Could not find "${binary}" on your PATH. Install OpenSSH and try again ` +
        `(macOS/Linux ship it by default; on Windows enable the "OpenSSH Client" optional feature).`
    );
    this.name = "SshBinaryNotFoundError";
  }
}

/** Thrown when a key already exists and overwrite was not requested. */
export class KeyExistsError extends Error {
  constructor(public readonly keyPath: string) {
    super(`An SSH key already exists at ${keyPath}`);
    this.name = "KeyExistsError";
  }
}

function isEnoent(err: unknown): boolean {
  return !!err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export interface GenerateKeyOptions {
  keyPath: string; // absolute path to the private key to create
  email: string; // used as the key comment
  overwrite?: boolean; // replace an existing key instead of throwing
}

/**
 * Generate an ed25519 key pair with an empty passphrase.
 * Equivalent to: ssh-keygen -t ed25519 -C <email> -f <keyPath> -N ""
 */
export function generateKey(opts: GenerateKeyOptions): void {
  const { keyPath, email, overwrite } = opts;

  // Ensure ~/.ssh exists with sensible permissions (mode is ignored on Windows).
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  const exists = fs.existsSync(keyPath) || fs.existsSync(keyPath + ".pub");
  if (exists) {
    if (!overwrite) throw new KeyExistsError(keyPath);
    // Remove first: ssh-keygen would otherwise prompt and block on stdin.
    fs.rmSync(keyPath, { force: true });
    fs.rmSync(keyPath + ".pub", { force: true });
  }

  const res = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-C", email, "-f", keyPath, "-N", ""],
    { encoding: "utf8" }
  );

  if (res.error) {
    if (isEnoent(res.error)) throw new SshBinaryNotFoundError("ssh-keygen");
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`ssh-keygen failed: ${(res.stderr || res.stdout || "").trim()}`);
  }
}

/** Read the public half of a key pair (`<keyPath>.pub`), trimmed. */
export function readPublicKey(keyPath: string): string {
  return fs.readFileSync(keyPath + ".pub", "utf8").trim();
}

export interface SshTestResult {
  ok: boolean;
  username?: string; // GitHub username when authentication succeeds
  message: string; // raw output / error for display
}

/**
 * Verify a key authenticates against a host (GitHub by default).
 *
 * GitHub intentionally exits non-zero even on success, so we detect the
 * well-known greeting in the output rather than relying on the exit code.
 */
export function testProfile(opts: { keyPath: string; host?: string }): SshTestResult {
  const host = opts.host ?? "git@github.com";

  const res = spawnSync(
    "ssh",
    [
      "-T",
      "-i",
      opts.keyPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      host,
    ],
    { encoding: "utf8", timeout: 20_000 }
  );

  if (res.error) {
    if (isEnoent(res.error)) return { ok: false, message: 'ssh binary not found on PATH' };
    return { ok: false, message: res.error.message };
  }

  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  const greeting = output.match(/Hi\s+([^!]+)!\s+You've successfully authenticated/i);
  if (greeting) {
    return { ok: true, username: greeting[1].trim(), message: output };
  }
  return { ok: false, message: output || `ssh exited with code ${res.status}` };
}
