package ai.arena.imperialcrown;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * A thin, offline-first WebView shell for Imperial Crown 3D.
 *
 * Assets are served from https://appassets.local/ rather than file:// so that
 * the game runs in a *secure origin*: localStorage (save games), pointer events,
 * WebAudio and WebGL2 all behave exactly as they do in Chrome, and there is no
 * same-origin/CORS weirdness. Requests are answered straight from the APK's
 * assets folder by a WebViewClient override, so nothing touches the network.
 *
 * v3 additions, all of them aimed at a mid-range phone (Realme 9i, Adreno 610):
 *
 *   • the renderer process is raised to IMPORTANT priority, so Android stops
 *     scheduling the game behind other work (the "one slow frame every second"
 *     stutter that no amount of shader optimisation can remove);
 *   • no scroll bars, no overscroll glow, no haptics: each of those is an extra
 *     layer the compositor has to merge over a full-screen GL surface;
 *   • the HTTP cache is left ON (the asset client supplies its own headers),
 *     which takes a second of black off a cold start;
 *   • WebView debugging is a debug-build feature only;
 *   • a killed renderer reloads the menu instead of taking the game down.
 */
public class MainActivity extends Activity {

    private static final String TAG = "ImperialCrown";
    private static final String HOST = "https://appassets.local/";
    private static final String START_URL = HOST + "index.html";

    private WebView web;
    private FrameLayout root;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // fullscreen, no title bar, keep the screen awake during a match
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        createWebView();

        /* Debug-only: enabling inspection in a release build makes Chromium
           keep extra bookkeeping (and exposes the page to adb). */
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
        hideSystemUi();
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        applySettings(web.getSettings());

        /* The WebView renderer is a separate process. Without this it runs at
           the default background priority and Android is free to schedule it
           behind other work -- which shows up as one slow frame every second
           or two, exactly the stutter this build exists to remove. */
        if (Build.VERSION.SDK_INT >= 26) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        // no scrollbars, no overscroll glow, no haptics: the page is a fixed
        // full-screen canvas and each of those is an extra compositor layer
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHapticFeedbackEnabled(false);

        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        web.setWebViewClient(new AssetClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " @" + m.lineNumber());
                return true;
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void applySettings(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // save games
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);   // the synth is unlocked by the first tap
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        /* LOAD_DEFAULT, not LOAD_NO_CACHE: the asset client already answers
           every request out of the APK and sets its own Cache-Control, so
           disabling the cache only forces the two bundle files to be decoded
           out of the zip again on every reload (a visible second of black on
           a cold start). */
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setOffscreenPreRaster(false);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            s.setSafeBrowsingEnabled(false);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            s.setAlgorithmicDarkeningAllowed(false);
        }
    }

    private void hideSystemUi() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        hideSystemUi();
    }

    @Override
    protected void onPause() {
        // keep the WebAudio context from holding the CPU while in the background
        web.evaluateJavascript("window.__imperial && window.__imperial.audio && window.__imperial.audio.suspend();", null);
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        // let the renderer drop its caches before Android kills the process
        if (level >= TRIM_MEMORY_RUNNING_LOW) {
            web.clearCache(false);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // never drop the player straight out of a match: ask the game first
        web.evaluateJavascript(
                "(function(){var a=window.__imperial;" +
                        "if(!a) return 'exit';" +
                        "if(a.menu && a.menu.isModalOpen && a.menu.isModalOpen()){a.menu.closeModal();return 'handled';}" +
                        "if(a.running){a.openPause();return 'handled';}" +
                        "if(a.menu && a.menu.isModalOpen && !a.menu.isModalOpen()){var m=document.getElementById('menuScreen');" +
                        "if(m && m.classList.contains('hidden')){a.quitToMenu();return 'handled';}}" +
                        "return 'exit';})()",
                value -> {
                    if (value == null || value.contains("exit")) {
                        finish();
                    }
                });
    }

    /** Serves the bundled web build from https://appassets.local/ with correct MIME types. */
    private class AssetClient extends WebViewClient {
        private final Map<String, String> mime = new HashMap<>();

        AssetClient() {
            mime.put("html", "text/html");
            mime.put("js", "application/javascript");
            mime.put("mjs", "application/javascript");
            mime.put("css", "text/css");
            mime.put("json", "application/json");
            mime.put("svg", "image/svg+xml");
            mime.put("png", "image/png");
            mime.put("jpg", "image/jpeg");
            mime.put("webp", "image/webp");
            mime.put("ico", "image/x-icon");
            mime.put("woff2", "font/woff2");
            mime.put("wasm", "application/wasm");
            mime.put("map", "application/json");
            mime.put("txt", "text/plain");
        }

        private String mimeOf(String path) {
            int dot = path.lastIndexOf('.');
            if (dot < 0) return "application/octet-stream";
            String ext = path.substring(dot + 1).toLowerCase();
            String m = mime.get(ext);
            return m != null ? m : "application/octet-stream";
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (!url.startsWith(HOST)) return null;
            String path = url.substring(HOST.length());
            int cut = path.indexOf('?');
            if (cut >= 0) path = path.substring(0, cut);
            cut = path.indexOf('#');
            if (cut >= 0) path = path.substring(0, cut);
            if (path.isEmpty()) path = "index.html";
            try {
                InputStream in = getAssets().open("www/" + path);
                Map<String, String> headers = new HashMap<>();
                // the game is fully offline: long-cache the hashed assets,
                // never cache the entry point
                headers.put("Cache-Control", path.equals("index.html") ? "no-cache" : "public, max-age=31536000");
                headers.put("Access-Control-Allow-Origin", "*");
                return new WebResourceResponse(mimeOf(path), "UTF-8", 200, "OK", headers, in);
            } catch (IOException e) {
                // SPA fallback: unknown paths render the game shell
                try {
                    InputStream in = getAssets().open("www/index.html");
                    return new WebResourceResponse("text/html", "UTF-8",
                            new ByteArrayInputStream(readAll(in)));
                } catch (IOException ignored) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                            new HashMap<String, String>(), new ByteArrayInputStream("not found".getBytes()));
                }
            }
        }

        private byte[] readAll(InputStream in) throws IOException {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return out.toByteArray();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (url.startsWith(HOST)) return false;
            // external links (credits, feedback) go to the system browser
            try {
                startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                        android.net.Uri.parse(url)));
            } catch (Exception ignored) {
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            Log.d(TAG, "page loaded: " + url);
        }

        /**
         * A mid-range phone will eventually kill the renderer under memory
         * pressure. The default behaviour is to take the whole game down with
         * it; instead, rebuild the view and reload so the player lands back on
         * the menu with their saved campaign intact.
         */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(TAG, "renderer gone (crashed=" + detail.didCrash() + ")");
            try {
                root.removeView(view);
                view.destroy();
            } catch (Exception ignored) {
            }
            createWebView();
            web.loadUrl(START_URL);
            return true;
        }
    }
}
