# Running the browser play-tests

The four `tests/*site.mjs` suites drive a real Chromium through Puppeteer and
save screenshots into `ci/`. They need Chromium's shared libraries, and a slim
container often has no `libnss3.so`:

```
/tmp/chromium: error while loading shared libraries: libnss3.so
```

Unpack the browser libraries once, into `.toolchain/nss/` (git-ignored):

```sh
mkdir -p /tmp/sp && cd /tmp/sp
npm pack @sparticuz/chromium --silent && tar -xzf sparticuz-chromium-*.tgz
python3 -c "import brotli;open('/tmp/al2023.tar','wb').write(brotli.decompress(open('package/bin/al2023.tar.br','rb').read()))"
mkdir -p /home/user/Age-of-empires-clone-build/imperial-crown-v4/.toolchain/nss
tar -xf /tmp/al2023.tar -C /tmp/nss
cp /tmp/nss/lib/*.so* /home/user/Age-of-empires-clone-build/imperial-crown-v4/.toolchain/nss/
```

`tests/run.mjs` prepends that directory to `LD_LIBRARY_PATH` when it exists, so
`node tests/run.mjs` then runs all 37 suites. Building first matters: the sites
serve `dist/`, not `src/`:

```sh
npm run build && node tests/run.mjs
```
