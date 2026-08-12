import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { DAEMON_V7_SCHEMA13_PROFILE } from "./profiles/daemon-v7-schema13.js";

interface LockedFile {
  readonly path: string;
  readonly relativePath: string;
  readonly handle: FileHandle;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}

export interface RuntimeClosureLock {
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeClosureProfile { readonly digest: string; readonly files: number }

function within(root: string, child: string): boolean {
  const value = relative(root, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}

async function readHandle(handle: FileHandle, size: bigint): Promise<Buffer> {
  if (size > BigInt(64 * 1024 * 1024)) throw new Error("runtime closure file is oversized");
  const length = Number(size);
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
    if (bytesRead === 0) throw new Error("runtime closure file changed during verification");
    offset += bytesRead;
  }
  return buffer;
}

async function digest(files: readonly LockedFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readHandle(file.handle, file.size);
    hash.update(Buffer.from(`${file.relativePath}\0${bytes.length}\0`));
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function closeAll(files: readonly LockedFile[]): Promise<void> {
  await Promise.all(files.map((file) => file.handle.close().catch(() => undefined)));
}

export async function lockVerifiedRuntimeClosure(
  packageRoot: string,
  expected: RuntimeClosureProfile = { digest: DAEMON_V7_SCHEMA13_PROFILE.distJavascriptClosureDigest, files: DAEMON_V7_SCHEMA13_PROFILE.distJavascriptClosureFiles },
): Promise<RuntimeClosureLock> {
  const root = await realpath(packageRoot);
  const dist = await realpath(resolve(root, "dist"));
  if (!within(root, dist)) throw new Error("runtime dist escaped package root");
  const paths: string[] = [];
  const pending = [dist];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error("runtime closure contains a symbolic link");
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile() && entry.name.endsWith(".js")) paths.push(path);
      else if (!metadata.isFile()) throw new Error("runtime closure contains a special file");
    }
  }
  paths.sort((left, right) => relative(root, left).replaceAll("\\", "/").localeCompare(relative(root, right).replaceAll("\\", "/"), "en-US"));
  if (paths.length !== expected.files) throw new Error("runtime closure file inventory mismatch");
  const locked: LockedFile[] = [];
  try {
    for (const path of paths) {
      const canonical = await realpath(path);
      if (canonical !== path || !within(root, canonical)) throw new Error("runtime closure path is untrusted");
      const handle = await open(canonical, "r");
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile()) { await handle.close(); throw new Error("runtime closure entry is not a file"); }
      locked.push({ path: canonical, relativePath: relative(root, canonical).replaceAll("\\", "/"), handle, dev: metadata.dev, ino: metadata.ino, size: metadata.size });
    }
    if (await digest(locked) !== expected.digest) throw new Error("runtime closure digest mismatch");
    const verify = async (): Promise<void> => {
      for (const file of locked) {
        const metadata = await lstat(file.path, { bigint: true });
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== file.dev || metadata.ino !== file.ino || metadata.size !== file.size) throw new Error("runtime closure identity changed");
      }
      if (await digest(locked) !== expected.digest) throw new Error("runtime closure content changed");
    };
    return Object.freeze({ verify, close: async () => closeAll(locked) });
  } catch (error) {
    await closeAll(locked);
    throw error;
  }
}
