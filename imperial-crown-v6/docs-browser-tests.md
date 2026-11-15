# Browser tests on minimal Linux

Build the production bundle first. The browser suites use `puppeteer-core` and the Chromium binary from `@sparticuz/chromium`; software WebGL verifies rendering and interaction but does not represent a Realme 9i's GPU performance.

```sh
npm ci
npm run build
npm run test:v5-browser
npm run test:browser
npm run test:responsive
```

On a slim Linux image Chromium may lack NSS/NSPR libraries. `scripts/browser-libs.mjs` extracts the libraries already included in `@sparticuz/chromium` to `/tmp/imperial-chromium-libs` and prints an `LD_LIBRARY_PATH` export. The browser npm scripts and the full test runner prepare these libraries automatically on Linux. After building, run `npm run test:ci`; add `-- --browser` to include the extra browser smoke test. Browser launch failures are reported as failures, not skipped based on a library-path guess. CI mode requires the bundle and all registered test files; it fails if they are missing.

`test:responsive` checks menu reachability, HUD geometry, a simulated display cutout, landscape controls and the portrait rotation prompt across ten emulated viewport sizes from 480×320 through 1280×800. It taps and scrolls the controls drawer, checks normal and large first-person controls and settings, and uses Chromium's `WEBGL_lose_context` extension to exercise recovery of an active battle. It throttles rendering to make software-WebGL interaction testing practical; it is not a frame-rate benchmark or an Android context-loss test.

The script resolves Chromium whether dependencies are installed in this directory or an ancestor workspace. Screenshots and reports are generated in the ignored `ci/` directory. These tests do not establish real Android WebView compatibility, performance, thermal behavior or touch ergonomics. The Android package currently requires Android 7.0 (API 24) or newer and OpenGL ES 3.0 / a working WebGL2 implementation; it cannot run on every Android device.
