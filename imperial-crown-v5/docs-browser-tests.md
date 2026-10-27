# Browser tests on minimal Linux

Build the production bundle first. The browser suites use `puppeteer-core` and the Chromium binary from `@sparticuz/chromium`; software WebGL verifies rendering and interaction but does not represent a Realme 9i's GPU performance.

```sh
npm ci
npm run build
npm run test:v5-browser
npm run test:browser
```

On a slim Linux image Chromium may lack NSS/NSPR libraries. `scripts/browser-libs.mjs` extracts the libraries already included in `@sparticuz/chromium` to `/tmp/imperial-chromium-libs` and prints an `LD_LIBRARY_PATH` export. The browser npm scripts use it automatically. For the full suite:

```sh
eval "$(node scripts/browser-libs.mjs --export)"
npm run test:ci
```

The script resolves Chromium whether dependencies are installed in this directory or an ancestor workspace. Screenshots and reports are generated in the ignored `ci/` directory. A real Android handset is still required for performance, thermal and touch-ergonomics sign-off.
