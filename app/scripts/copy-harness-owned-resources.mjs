import { copyFile, mkdir } from "node:fs/promises";

const resources = Object.freeze([
  ["../harness-sidecar/vendor/package.json", "../harness-sidecar/dist/src/vendor/package.json"],
  ["../harness-sidecar/vendor/prime-daemon-adapter-v0.7.1.mjs", "../harness-sidecar/dist/src/vendor/prime-daemon-adapter-v0.7.1.mjs"],
  ["../harness-sidecar/vendor/prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt", "../harness-sidecar/dist/src/vendor/prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt"],
  ["../harness-sidecar/vendor/v0.7.2/package.json", "../harness-sidecar/dist/src/vendor/v0.7.2/package.json"],
  ["../harness-sidecar/vendor/v0.7.2/prime-daemon-adapter.mjs", "../harness-sidecar/dist/src/vendor/v0.7.2/prime-daemon-adapter.mjs"],
  ["../harness-sidecar/vendor/v0.7.2/prime-daemon-adapter.mjs.LEGAL.txt", "../harness-sidecar/dist/src/vendor/v0.7.2/prime-daemon-adapter.mjs.LEGAL.txt"],
]);

for (const [sourcePath, targetPath] of resources) {
  const source = new URL(sourcePath, import.meta.url);
  const target = new URL(targetPath, import.meta.url);
  await mkdir(new URL("./", target), { recursive: true });
  await copyFile(source, target);
}
