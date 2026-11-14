package com.donalvaro.zenox;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Sends one packed archive to the owner server over the WebView's own owner
 * session cookie. The body is streamed from disk, so a large pack costs no extra
 * memory on the phone.
 */
public class ZenoxUploader {

    /** Origin of the page the WebView is showing, e.g. https://host (no path). */
    public static String originOf(String pageUrl) {
        if (pageUrl == null) return null;
        try {
            URL url = new URL(pageUrl);
            int port = url.getPort();
            String base = url.getProtocol() + "://" + url.getHost();
            if (port > 0 && port != url.getDefaultPort()) base += ":" + port;
            return base;
        } catch (Exception error) {
            return null;
        }
    }

    /** Returns null on success, otherwise a short reason. */
    public static String upload(File file, String origin, String cookie) {
        HttpURLConnection connection = null;
        FileInputStream in = null;
        try {
            String endpoint = origin + "/api/owner/upload?name=" + URLEncoder.encode(file.getName(), "UTF-8");
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(180000);
            connection.setFixedLengthStreamingMode(file.length());
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setRequestProperty("Accept", "application/json");
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);

            in = new FileInputStream(file);
            OutputStream out = connection.getOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            out.flush();
            out.close();

            int code = connection.getResponseCode();
            InputStream body = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (body != null) {
                byte[] sink = new byte[4096];
                while (body.read(sink) != -1) {
                    // Drain so the connection can be reused.
                }
                body.close();
            }
            if (code == 200) return null;
            if (code == 403) return "انتهت جلسة ZENOX — سجّل الدخول من جديد ثم ارفع.";
            if (code == 413) return "الملف أكبر من الحد المسموح على الخادم.";
            return "الخادم رفض الرفع (HTTP " + code + ")";
        } catch (Exception error) {
            return "تعذر الوصول للخادم — سيبقى الملف على الهاتف للمحاولة لاحقًا.";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                }
            }
            if (connection != null) connection.disconnect();
        }
    }
}
