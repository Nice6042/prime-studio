# Reviewed Prime daemon adapter

`prime-daemon-adapter-v0.7.1.mjs` is a build-generated, application-owned ESM
adapter made from the public root exports of `prime-agent` 0.7.1. It exposes
only `DaemonClient`, `DaemonAgentConnection`, `AuthStorage`, `ModelRegistry`,
`DAEMON_PROTOCOL_INFO`, and `defaultDaemonSocketPath`.

The source package is MIT licensed (Copyright 2025 Mario Zechner; Copyright
2026 Prime Intellect). Bundled dependency notices are retained in the adjacent
`prime-daemon-adapter-v0.7.1.mjs.LEGAL.txt` file. The adapter is regenerated
with `node scripts/build-reviewed-prime-adapter.mjs <absolute-package-root>`;
the package root is an input and is never embedded in the output.

Runtime discovery only reads and verifies the installed package identity. It
does not execute installed package code. Studio hashes the owned adapter bytes
before evaluating those exact bytes through a data URL, preventing mutable-path
imports and check-to-use races.
