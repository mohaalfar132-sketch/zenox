package com.donalvaro.zenox;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * ZENOX phone shell: a WebView around the owner's server.
 *
 * It also carries the phone tool the owner asked for: collect files or a whole
 * folder, pack them into one zip on the device so the real size is known, keep
 * the archive when there is no connection, and upload it by itself as soon as
 * the phone is online again.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "zenox";
    private static final String KEY_URL = "server_url";
    private static final int REQ_FILE = 1001;
    private static final int REQ_PACK_FILES = 1002;
    private static final int REQ_PACK_FOLDER = 1003;

    // Filled while the phone's file picker is open, then handed back to the page.
    private ValueCallback<Uri[]> pendingFiles;
    private WebView web;
    private ProgressBar bar;
    private FileVault vault;
    private ConnectivityManager.NetworkCallback networkCallback;
    private volatile boolean uploading;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        vault = new FileVault(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#05070F"));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(-1, 8));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(false);
        // Needed so the page can receive the file the owner picks from the phone.
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setBackgroundColor(Color.parseColor("#05070F"));
        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new PhoneTool(), "ZenoxNative");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                bar.setVisibility(progress < 100 ? View.VISIBLE : View.GONE);
                bar.setProgress(progress);
            }

            /**
             * File inputs in the owner page open the phone's own picker. The Android
             * document picker grants access to exactly what the owner chooses, so the
             * app never needs a blanket storage permission.
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(pick, "اختر ملفًا من الهاتف"), REQ_FILE);
                } catch (Exception error) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });
        root.addView(buildToolbar(), new LinearLayout.LayoutParams(-1, -2));
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(root);

        String saved = prefs().getString(KEY_URL, "");
        if (saved == null || saved.trim().isEmpty()) {
            askForUrl(false);
        } else {
            web.loadUrl(saved);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /**
     * A native bar so the owner reaches the same console the web panel has:
     * one tap for the chat, one for the owner center, and one command box that
     * executes the order on the platform itself and reports what was done.
     */
    private LinearLayout buildToolbar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(Color.parseColor("#0A0D1F"));
        bar.setPadding(dp(8), dp(6), dp(8), dp(6));

        bar.addView(toolButton("المحادثة", new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                openPath("");
            }
        }));
        bar.addView(toolButton("مركز ZENOX", new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                openPath("/owner");
            }
        }));
        bar.addView(toolButton("أمر تنفيذي", new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                askCommand();
            }
        }));
        return bar;
    }

    private android.widget.TextView toolButton(String label, View.OnClickListener listener) {
        android.widget.TextView button = new android.widget.TextView(this);
        button.setText(label);
        button.setTextSize(13);
        button.setTextColor(Color.parseColor("#E2E8F0"));
        button.setGravity(android.view.Gravity.CENTER);
        button.setPadding(dp(12), dp(8), dp(12), dp(8));
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(Color.parseColor("#141B34"));
        shape.setCornerRadius(dp(10));
        button.setBackground(shape);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        params.setMargins(0, 0, dp(6), 0);
        button.setLayoutParams(params);
        button.setOnClickListener(listener);
        return button;
    }

    private void openPath(String path) {
        String saved = prefs().getString(KEY_URL, "");
        String origin = ZenoxUploader.originOf(saved);
        if (origin == null) {
            askForUrl(false);
            return;
        }
        web.loadUrl(origin + path);
    }

    /** One command, executed by the owner agent on the platform, then the page reloads. */
    private void askCommand() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(2);
        input.setHint("مثال: أضف مفتاح Groq الجديد، أو عدّل نص صفحة البداية");
        new AlertDialog.Builder(this)
            .setTitle("أمر تنفيذي")
            .setMessage("يُنفّذ الأمر بصلاحيات ZENOX على المنصة والتطبيق، ثم يُعيد تحميل الصفحة.")
            .setView(input)
            .setPositiveButton("نفّذ", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface dialog, int which) {
                    final String command = input.getText().toString().trim();
                    if (command.isEmpty()) return;
                    showProgress("جارٍ التنفيذ بصلاحيات ZENOX…");
                    new Thread(new Runnable() {
                        @Override
                        public void run() {
                            final String result = postCommand(command);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    hideProgress();
                                    new AlertDialog.Builder(MainActivity.this)
                                        .setTitle("نتيجة الأمر")
                                        .setMessage(result)
                                        .setPositiveButton("حسنًا", new android.content.DialogInterface.OnClickListener() {
                                            @Override
                                            public void onClick(android.content.DialogInterface dialog, int which) {
                                                if (web != null) web.reload();
                                            }
                                        })
                                        .show();
                                }
                            });
                        }
                    }).start();
                }
            })
            .setNegativeButton("إلغاء", null)
            .show();
    }

    private void showProgress(String text) {
        if (bar != null) {
            bar.setIndeterminate(true);
            bar.setVisibility(View.VISIBLE);
        }
    }

    private void hideProgress() {
        if (bar != null) {
            bar.setIndeterminate(false);
            bar.setVisibility(View.GONE);
        }
    }

    /** Runs one owner command through the platform agent and returns what it did. */
    private String postCommand(String command) {
        String origin = ZenoxUploader.originOf(prefs().getString(KEY_URL, ""));
        if (origin == null) return "افتح صفحة ZENOX مرة واحدة ثم أعد المحاولة.";
        HttpURLConnection connection = null;
        try {
            JSONObject message = new JSONObject();
            message.put("role", "user");
            message.put("content", command);
            JSONArray messages = new JSONArray();
            messages.put(message);
            JSONObject payload = new JSONObject();
            payload.put("mode", "owner-commands");
            payload.put("audience", "owner");
            payload.put("messages", messages);
            JSONObject body = new JSONObject();
            body.put("0", new JSONObject().put("json", payload));

            connection = (HttpURLConnection) new URL(origin + "/api/trpc/chat.complete?batch=1").openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(300000);
            connection.setRequestProperty("Content-Type", "application/json");
            String cookie = CookieManager.getInstance().getCookie(origin);
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            OutputStream out = connection.getOutputStream();
            out.write(body.toString().getBytes("UTF-8"));
            out.close();

            int code = connection.getResponseCode();
            InputStream in = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            StringBuilder raw = new StringBuilder();
            if (in != null) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) raw.append(new String(buffer, 0, read, "UTF-8"));
                in.close();
            }
            if (code == 403) return "هذه ليست جلسة ZENOX. سجّل الدخول من مركز ZENOX ثم أعد الأمر.";
            if (code == 412) return "لا يوجد مفتاح ذكاء اصطناعي شغّال بعد. أضفه من صفحة المفاتيح ثم أعد الأمر.";
            if (code >= 400) return "الخادم رفض الأمر (HTTP " + code + ").";
            JSONObject data = new JSONObject(raw.toString())
                .getJSONArray("0")
                .getJSONObject(0)
                .getJSONObject("result")
                .getJSONObject("data")
                .getJSONObject("json");
            StringBuilder text = new StringBuilder(data.optString("content", "تم التنفيذ."));
            JSONArray steps = data.optJSONArray("steps");
            if (steps != null && steps.length() > 0) {
                text.append("\n\nما نُفّذ:");
                for (int i = 0; i < steps.length(); i += 1) {
                    JSONObject step = steps.getJSONObject(i);
                    text.append("\n• ").append(step.optString("summary"));
                }
            }
            return text.toString();
        } catch (Exception error) {
            return "تعذر تنفيذ الأمر الآن. تحقق من الاتصال ثم أعد المحاولة.";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    // ---------------------------------------------------------------- phone tool

    /**
     * The bridge the owner page calls. Every method is safe on any thread except
     * the pickers, which need the UI thread and are posted there.
     */
    public class PhoneTool {
        @JavascriptInterface
        public String state() {
            try {
                JSONObject state = new JSONObject();
                state.put("online", isOnline());
                state.put("uploading", uploading);
                state.put("packs", packsJson());
                state.put("totalBytes", vault.totalBytes());
                return state.toString();
            } catch (Exception error) {
                return "{\"online\":false,\"packs\":[],\"totalBytes\":0}";
            }
        }

        @JavascriptInterface
        public String listPacks() {
            return packsJson().toString();
        }

        @JavascriptInterface
        public void pickFiles() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("*/*");
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivityForResult(pick, REQ_PACK_FILES);
                    } catch (Exception error) {
                        emit("upload", message("لا يوجد مستكشف ملفات على هذا الجهاز."));
                    }
                }
            });
        }

        @JavascriptInterface
        public void pickFolder() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivityForResult(pick, REQ_PACK_FOLDER);
                    } catch (Exception error) {
                        emit("upload", message("تعذر فتح مستكشف المجلدات."));
                    }
                }
            });
        }

        /** Uploads every waiting archive; does nothing (and says why) when offline. */
        @JavascriptInterface
        public void packAppData() {
            emit("upload", message("جارٍ جمع بيانات التطبيق على الهاتف…"));
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        File pack = vault.packAppData("بيانات-التطبيق-" + FileVault.stamp());
                        JSONObject payload = new JSONObject();
                        if (pack == null) {
                            payload.put("ok", false);
                            payload.put("message", "لم تُقرأ أي بيانات من التطبيق.");
                        } else {
                            payload.put("ok", true);
                            payload.put("message", "جُمعت بيانات التطبيق: " + pack.getName() + " — " + FileVault.humanSize(pack.length()));
                        }
                        emit("upload", payload.toString());
                        emit("packs", packsJson().toString());
                        if (isOnline()) startUploads();
                    } catch (Exception error) {
                        emit("upload", message("تعذر جمع بيانات التطبيق."));
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void uploadNow() {
            if (!isOnline()) {
                emit("upload", message("لا يوجد إنترنت الآن. الملفات محفوظة على الهاتف وستُرفع تلقائيًا عند الاتصال."));
                return;
            }
            startUploads();
        }

        @JavascriptInterface
        public void deletePack(String name) {
            File target = new File(vault.dir(), FileVault.safeName(name));
            markerFor(target).delete();
            target.delete();
            emit("packs", packsJson().toString());
        }
    }

    private File markerFor(File pack) {
        return new File(vault.dir(), pack.getName() + ".sent");
    }

    private boolean isSent(File pack) {
        return markerFor(pack).exists();
    }

    private void markSent(File pack) {
        try {
            markerFor(pack).createNewFile();
        } catch (Exception ignored) {
            // The archive is still kept; only the "already uploaded" badge is lost.
        }
    }

    private JSONArray packsJson() {
        JSONArray list = new JSONArray();
        for (File file : vault.packs()) {
            try {
                JSONObject item = new JSONObject();
                item.put("name", file.getName());
                item.put("size", file.length());
                item.put("sizeText", FileVault.humanSize(file.length()));
                item.put("at", file.lastModified());
                item.put("sent", isSent(file));
                list.put(item);
            } catch (Exception ignored) {
            }
        }
        return list;
    }

    private String message(String text) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("message", text);
            payload.put("ok", false);
            return payload.toString();
        } catch (Exception error) {
            return "{}";
        }
    }

    /** Sends a result to the page; the page installs window.zenoxNativeResult. */
    private void emit(String event, String json) {
        final String script = "window.zenoxNativeResult&&window.zenoxNativeResult(" + JSONObject.quote(event) + "," + json + ");";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(script, null);
            }
        });
    }

    private void packAsync(final List<Uri> uris, final String label) {
        emit("upload", message("جارٍ ضغط " + uris.size() + " ملف على الهاتف…"));
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File pack = vault.pack(uris, label);
                    JSONObject payload = new JSONObject();
                    if (pack == null) {
                        payload.put("ok", false);
                        payload.put("message", "لم يُقرأ أي ملف — جرّب اختيارها مرة أخرى.");
                    } else {
                        payload.put("ok", true);
                        payload.put("message", "تم الضغط: " + pack.getName() + " — " + FileVault.humanSize(pack.length())
                            + (isOnline() ? ". جارٍ الرفع…" : ". بلا إنترنت: سيُرفع تلقائيًا عند الاتصال."));
                    }
                    emit("upload", payload.toString());
                    emit("packs", packsJson().toString());
                    if (isOnline()) startUploads();
                } catch (Exception error) {
                    emit("upload", message("تعذر ضغط الملفات على الهاتف."));
                }
            }
        }).start();
    }

    /** Uploads the queue one archive at a time, deleting what the server accepted. */
    private void startUploads() {
        if (uploading) return;
        // Files stay on the phone for inspection: only unsent archives go up,
        // and a successful upload is marked instead of being deleted.
        final List<File> queue = new ArrayList<File>();
        for (File file : vault.packs()) {
            if (!isSent(file)) queue.add(file);
        }
        if (queue.isEmpty()) {
            emit("packs", packsJson().toString());
            return;
        }
        uploading = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                String origin = ZenoxUploader.originOf(web == null ? null : web.getUrl());
                String cookie = origin == null ? null : CookieManager.getInstance().getCookie(origin);
                int done = 0;
                String problem = null;
                if (origin == null) problem = "افتح صفحة ZENOX أولًا ثم ارفع.";
                for (File file : queue) {
                    if (origin == null) break;
                    String error = ZenoxUploader.upload(file, origin, cookie);
                    if (error == null) {
                        done += 1;
                        markSent(file);
                    } else {
                        problem = error;
                        break;
                    }
                }
                uploading = false;
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("ok", problem == null);
                    payload.put("uploaded", done);
                    payload.put("remaining", vault.packs().size());
                    String text;
                    if (done > 0) {
                        text = "رُفع " + done + " أرشيف إلى ZENOX، والملفات باقية على الهاتف للفحص";
                        if (problem != null) text += ". توقف الباقي: " + problem;
                        else text += ".";
                    } else {
                        text = problem == null ? "لا يوجد ما يُرفع." : problem;
                    }
                    payload.put("message", text);
                    emit("upload", payload.toString());
                } catch (Exception ignored) {
                }
                emit("packs", packsJson().toString());
                emit("state", null);
            }
        }).start();
    }

    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        Network active = manager.getActiveNetwork();
        if (active == null) return false;
        NetworkCapabilities caps = manager.getNetworkCapabilities(active);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    // ------------------------------------------------------------- connectivity

    @Override
    protected void onResume() {
        super.onResume();
        if (networkCallback != null) return;
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                // Back online: send whatever was packed while offline.
                if (!vault.packs().isEmpty()) startUploads();
                emit("state", null);
            }

            @Override
            public void onLost(Network network) {
                emit("state", null);
            }
        };
        try {
            NetworkRequest request = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
            manager.registerNetworkCallback(request, networkCallback);
        } catch (Exception error) {
            networkCallback = null;
        }
    }

    @Override
    protected void onPause() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager != null && networkCallback != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
            }
        }
        networkCallback = null;
        super.onPause();
    }

    // ------------------------------------------------------------------ address

    /** Long-press the title asks for a new address; the old one stays until changed. */
    private void askForUrl(boolean cancelable) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://your-zenox-host");
        String current = prefs().getString(KEY_URL, "");
        if (current != null && !current.isEmpty()) input.setText(current);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
            .setTitle("عنوان ZENOX")
            .setMessage("الصق رابط التطبيق (يبدأ بـ https). يُحفظ على جهازك ولا يُرسل لأي مكان.")
            .setView(input)
            .setPositiveButton("اتصال", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface dialog, int which) {
                    String value = input.getText().toString().trim();
                    if (!value.startsWith("http://") && !value.startsWith("https://")) value = "https://" + value;
                    while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
                    prefs().edit().putString(KEY_URL, value).apply();
                    web.loadUrl(value);
                }
            });
        if (cancelable) builder.setNegativeButton("إلغاء", null);
        builder.show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PACK_FILES) {
            if (resultCode == RESULT_OK && data != null) {
                List<Uri> uris = new ArrayList<Uri>();
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    for (int i = 0; i < count; i += 1) uris.add(data.getClipData().getItemAt(i).getUri());
                } else if (data.getData() != null) {
                    uris.add(data.getData());
                }
                if (!uris.isEmpty()) packAsync(uris, "ملفات-" + FileVault.stamp());
            }
            return;
        }
        if (requestCode == REQ_PACK_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                final Uri tree = data.getData();
                emit("upload", message("جارٍ قراءة المجلد وضغطه على الهاتف…"));
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        List<Uri> uris = new ArrayList<Uri>();
                        int found = vault.collectTree(tree, uris);
                        if (found == 0) {
                            emit("upload", message("المجلد فارغ أو غير قابل للقراءة."));
                            return;
                        }
                        packAsync(uris, "مجلد-" + FileVault.stamp());
                    }
                }).start();
            }
            return;
        }
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i += 1) results[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        if (pendingFiles != null) pendingFiles.onReceiveValue(results);
        pendingFiles = null;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            askForUrl(true);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
