# Browser-shell accessibility tests

These tests build the Vite frontend and then launch its loopback-only preview in Playwright Chromium. They inject a browser-only Tauri IPC fixture to exercise frontend states. They do **not** launch, package, or validate a Tauri desktop application.

`npm run test:browser-shell` is the default CI and local regression command. It runs the strict gate, blocks every off-loopback browser request, blocks service workers, uses zero retries, and accepts no serious or critical axe violations.

`npm run test:browser-shell:strict` is the explicit release-gate spelling of the same zero-violation contract. The checked-in `axe-baseline.json` records an empty serious/critical fingerprint for all five scenarios, and `npm run test:browser-shell:baseline` verifies that exact fingerprint. The baseline command remains available for auditing fingerprint changes; it is not a weaker default.

Failure artifacts are retained only when a test fails: screenshots, traces, and the HTML report are ignored by Git.
