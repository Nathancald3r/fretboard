package app.fretboard;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.OutputStream;
import java.util.Collections;
import java.util.Set;

/**
 * Fretboard as an Android app: the web app is bundled in the APK and shown in a WebView on a
 * private https origin, so it works offline and nothing else can be loaded into it. Links to
 * other sites open in the browser; the only door from the page to Android is the file-save
 * message listener below, restricted to that origin.
 */
public class MainActivity extends ComponentActivity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final String START_URL = ORIGIN + "/www/index.html";
    private static final int BG = 0xFF14161A;

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private ActivityResultLauncher<Intent> fileChooser;
    private ActivityResultLauncher<String> micPermission;
    private WebViewAssetLoader assets;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Practice app: the screen stays on while it's in front.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/www/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        fileChooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileCallback == null) return;
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
            fileCallback = null;
        });
        micPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            PermissionRequest request = pendingPermission;
            pendingPermission = null;
            if (request == null) return;
            if (granted) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else request.deny();
        });

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Keep the page clear of the status bar, the gesture / navigation bar, the camera cutout
        // and the keyboard, so nothing sits under the home or back controls.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), root);
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customView != null) { hideCustom(); return; }
                if (web.canGoBack()) { web.goBack(); return; }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(START_URL);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView w = new WebView(this);
        w.setBackgroundColor(BG);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // library, settings
        s.setDatabaseEnabled(true);            // IndexedDB
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSafeBrowsingEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(true);     // window.open, for the tab-site searches
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        w.setWebViewClient(new AppClient());
        w.setWebChromeClient(new AppChrome());

        // Saving a file (backups): a message the page can only send from our own origin.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Set<String> origins = Collections.singleton(ORIGIN);
            WebViewCompat.addWebMessageListener(w, "fretboardAndroid", origins, (view, message, sourceOrigin, isMainFrame, reply) -> {
                if (isMainFrame) saveFile(message);
            });
        }
        return w;
    }

    private class AppClient extends WebViewClientCompat {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return assets.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (HOST.equals(uri.getHost()) && "https".equals(uri.getScheme())) return false;
            openExternal(uri);
            return true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's renderer died (out of memory): start over rather than crash.
            if (view == web) {
                root.removeView(web);
                web.destroy();
                web = createWebView();
                root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.loadUrl(START_URL);
            }
            return true;
        }
    }

    private class AppChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*"); // Guitar Pro files have no common type
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                fileChooser.launch(pick);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // Microphone for our own pages only (tuner, note check, singing); never the camera.
            boolean ours = ORIGIN.equals(originOf(request.getOrigin()));
            boolean wantsOnlyAudio = request.getResources().length == 1
                    && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0]);
            if (!ours || !wantsOnlyAudio) { request.deny(); return; }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                if (pendingPermission != null) pendingPermission.deny();
                pendingPermission = request;
                micPermission.launch(Manifest.permission.RECORD_AUDIO);
            }
        }

        // window.open(url): hand the address to the browser, never show it in the app.
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (!isUserGesture) return false;
            WebView temp = new WebView(MainActivity.this);
            temp.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    openExternal(request.getUrl());
                    v.destroy();
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(temp);
            resultMsg.sendToTarget();
            return true;
        }

        // Fullscreen for the YouTube player.
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customViewCallback = callback;
            web.setVisibility(View.INVISIBLE);
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        @Override
        public void onHideCustomView() {
            hideCustom();
        }
    }

    private void hideCustom() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
    }

    private static String originOf(Uri uri) {
        return uri.getScheme() + "://" + uri.getHost();
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) return; // no intent:, file:, javascript: …
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) { /* no browser */ }
    }

    // {name, mime, data (base64)} from the page → a file in Downloads.
    private void saveFile(WebMessageCompat message) {
        try {
            JSONObject o = new JSONObject(message.getData());
            // Only backups: a .json file of a sane size, whatever the page claims.
            String name = o.getString("name").replaceAll("[^A-Za-z0-9._ -]", "_");
            String data = o.getString("data");
            if (!name.endsWith(".json") || data.length() > 70_000_000) throw new IllegalArgumentException("not a backup");
            String mime = "application/json";
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, "Download");
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("no file");
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                out.write(bytes);
            }
            runOnUiThread(() -> Toast.makeText(this, "Saved " + name + " to Downloads", Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "Could not save the file", Toast.LENGTH_LONG).show());
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) { root.removeView(web); web.destroy(); }
        super.onDestroy();
    }
}
