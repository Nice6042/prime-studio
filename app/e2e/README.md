# Browser-shell accessibility tests

These tests build the Vite frontend and then launch its loopback-only preview in Playwright Chromium. They inject a browser-only Tauri IPC fixture to exercise frontend states. They do **not** launch, package, or validate a Tauri desktop application.

`npm run test:browser-shell` is the default CI and local regression command. It runs the strict gate, blocks every off-loopback browser request, blocks service workers, uses zero retries, and accepts no serious or critical axe violations.

`npm run test:browser-shell:strict` is the explicit release-gate spelling of the same zero-violation contract. The checked-in `axe-baseline.json` records an empty serious/critical fingerprint for all five scenarios, and `npm run test:browser-shell:baseline` verifies that exact fingerprint. The baseline command remains available for auditing fingerprint changes; it is not a weaker default.

Failure artifacts are retained only when a test fails: screenshots, traces, and the HTML report are ignored by Git.

## ZIP/product acceptance matrix

`acceptance-matrix.spec.ts` and `narrow.spec.ts` cover the supplied product structure without inventing runtime evidence:

- all 13 Settings destinations and the separate archived-catalog route;
- parent conversation isolation and selected-child Chat, Activity, and Files routes;
- Harness overview, queue, tools, context, usage, activity, outputs, and sources;
- editor empty and Canvas states, including explicit absence of unbound Diff/Edit/save authority;
- 1280 and 1600 wide layouts, 820 and 640 compact layouts, and a 320-by-200 CSS viewport at DPR 2 (640-by-400 physical-pixel equivalent);
- keyboard activation/focus restoration, bounded geometry, and strict axe scans.

Production defects discovered by the matrix are isolated with Playwright `test.fail` contracts. They remain executable and must be converted to ordinary passing assertions when the corresponding production fix is integrated. The browser fixture must not fabricate Harness inspector details, artifact identities, or save-conflict outcomes merely to make unavailable production states appear available.
