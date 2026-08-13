import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../harness-sidecar/vendor/prime-daemon-adapter-v0.7.1.mjs", import.meta.url);
const targetDirectory = new URL("../harness-sidecar/dist/src/vendor/", import.meta.url);
const target = new URL("prime-daemon-adapter-v0.7.1.mjs", targetDirectory);
const packageSource = new URL("../harness-sidecar/vendor/package.json", import.meta.url);
const packageTarget = new URL("package.json", targetDirectory);
const legalSource = new URL("../harness-sidecar/vendor/prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt", import.meta.url);
const legalTarget = new URL("prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt", targetDirectory);

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
await copyFile(packageSource, packageTarget);
await copyFile(legalSource, legalTarget);
