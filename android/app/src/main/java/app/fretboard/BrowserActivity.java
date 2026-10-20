package app.fretboard;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.FileInputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * A small browser for the tab sites. Downloads work here (a plain WebView can't download),
 * and a tab file that finishes downloading is added to the library by itself: this screen
 * closes and Fretboard imports it. The page has no way to call into the app.
 */
public class BrowserActivity extends ComponentActivity {
    static final String EXTRA_URL = "url";
    private static final int BG = 0xFF14161A;
    private static final int PANEL = 0xFF1D2026;
    private static final int TEXT = 0xFFE8E6E1;
    private static final int MUTED = 0xFF9AA0AB;
    private static final String[] TAB_TYPES = {".gp", ".gp3", ".gp4", ".gp5", ".gpx", ".gtp", ".musicxml", ".mxl", ".xml", ".ptb"};

    private WebView web;
    private TextView title;
    private ProgressBar progress;
    private DownloadManager downloads;
    private long watching = -1;

    private final BroadcastReceiver done = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != watching) return;
            watching = -1;
            deliver(id);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        downloads = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(PANEL);
        int pad = dp(8);
        bar.setPadding(pad, 0, pad, 0);
        Button close = button("✕  Done");
        close.setOnClickListener(v -> finish());
        Button back = button("‹");
        back.setOnClickListener(v -> { if (web.canGoBack()) web.goBack(); });
        title = new TextView(this);
        title.setTextColor(MUTED);
        title.setTextSize(13);
        title.setSingleLine(true);
        title.setPadding(dp(8), 0, dp(8), 0);
        bar.addView(close);
        bar.addView(back);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSafeBrowsingEnabled(true);
        // Some sites refuse the "wv" in a WebView's user agent.
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String scheme = u.getScheme();
                if ("https".equals(scheme) || "http".equals(scheme)) return false;
                // intent: links (a site pushing its app) carry a web fallback; follow that, ignore the rest.
                if ("intent".equals(scheme)) {
                    String raw = u.toString();
                    int i = raw.indexOf("S.browser_fallback_url=");
                    if (i >= 0) {
                        String f = Uri.decode(raw.substring(i + 23).split(";")[0]);
                        if (f.startsWith("https://")) v.loadUrl(f);
                    }
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                title.setText(Uri.parse(url).getHost());
            }
        });
        s.setSupportMultipleWindows(true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture, android.os.Message resultMsg) {
                // target=_blank / window.open: open it in this same browser.
                WebView tmp = new WebView(BrowserActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView t, WebResourceRequest r) {
                        String sc = r.getUrl().getScheme();
                        if ("https".equals(sc) || "http".equals(sc)) web.loadUrl(r.getUrl().toString());
                        t.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(tmp);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onProgressChanged(WebView v, int p) {
                progress.setProgress(p);
                progress.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> download(url, userAgent, contentDisposition, mimeType));
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), root);
        c.setAppearanceLightStatusBars(false);
        c.setAppearanceLightNavigationBars(false);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack();
                else finish();
            }
        });

        ContextCompat.registerReceiver(this, done, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED);

        String url = getIntent().getStringExtra(EXTRA_URL);
        if (state != null) web.restoreState(state);
        else if (url != null) web.loadUrl(url);
    }

    private Button button(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(TEXT);
        b.setBackgroundColor(0x00000000);
        b.setMinWidth(dp(48));
        return b;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void download(String url, String userAgent, String disposition, String mime) {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        String name = URLUtil.guessFileName(url, disposition, mime);
        DownloadManager.Request r = new DownloadManager.Request(uri);
        r.addRequestHeader("User-Agent", userAgent);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) r.addRequestHeader("Cookie", cookies);
        r.setTitle(name);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        watching = downloads.enqueue(r);
        Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
    }

    // A finished download: a tab file goes to the library; anything else just stays in Downloads.
    private void deliver(long id) {
        try (android.database.Cursor c = downloads.query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return;
            if (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) != DownloadManager.STATUS_SUCCESSFUL) {
                Toast.makeText(this, "The download failed", Toast.LENGTH_LONG).show();
                return;
            }
            String name = Uri.parse(c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))).getLastPathSegment();
            String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
            boolean tab = false;
            for (String ext : TAB_TYPES) if (lower.endsWith(ext)) tab = true;
            if (!tab) {
                Toast.makeText(this, "Saved " + name + " to Downloads (not a tab file)", Toast.LENGTH_LONG).show();
                return;
            }
            try (ParcelFileDescriptor pfd = downloads.openDownloadedFile(id);
                 InputStream in = new FileInputStream(pfd.getFileDescriptor())) {
                java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[65536];
                for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
                byte[] bytes = buf.toByteArray();
                if (bytes.length > 30_000_000) throw new IllegalStateException("too big");
                MainActivity.queueImport(name, Base64.encodeToString(bytes, Base64.NO_WRAP));
            }
            finish(); // back to Fretboard, which adds it
        } catch (Exception e) {
            Toast.makeText(this, "Could not add the file; it is in Downloads", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(done); } catch (Exception ignored) { /* not registered */ }
        web.destroy();
        super.onDestroy();
    }
}
