package com.donalvaro.zenox;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Collects the files the owner picks from the phone into one zip kept on the
 * device. The zip survives restarts, so packing works with no connection and the
 * upload can happen later, whenever the phone is online.
 */
public class FileVault {
    private static final String DIR = "packs";
    // A folder walk that never ends would hang the tool, so the depth is bounded.
    private static final int MAX_DEPTH = 8;

    private final Context context;

    public FileVault(Context context) {
        this.context = context.getApplicationContext();
    }

    public File dir() {
        File folder = new File(context.getFilesDir(), DIR);
        if (!folder.exists()) folder.mkdirs();
        return folder;
    }

    /** Every packed archive, newest first. */
    public List<File> packs() {
        List<File> list = new ArrayList<File>();
        File[] all = dir().listFiles();
        if (all == null) return list;
        for (File file : all) {
            if (file.isFile() && file.getName().endsWith(".zip")) list.add(file);
        }
        java.util.Collections.sort(list, new Comparator<File>() {
            @Override
            public int compare(File left, File right) {
                return Long.compare(right.lastModified(), left.lastModified());
            }
        });
        return list;
    }

    public long totalBytes() {
        long total = 0;
        for (File file : packs()) total += file.length();
        return total;
    }

    public static String safeName(String raw) {
        String cleaned = (raw == null ? "" : raw).replaceAll("[^\\p{L}\\p{N}._-]", "_").replaceAll("^\\.+", "");
        if (cleaned.length() > 90) cleaned = cleaned.substring(0, 90);
        return cleaned.isEmpty() ? "pack" : cleaned;
    }

    /** Zips the given documents into a new archive; returns null when nothing was readable. */
    public File pack(List<Uri> uris, String label) throws Exception {
        if (uris == null || uris.isEmpty()) return null;
        String base = safeName(label);
        File target = new File(dir(), base + ".zip");
        int index = 1;
        while (target.exists()) {
            target = new File(dir(), base + "-" + index + ".zip");
            index += 1;
        }
        ContentResolver resolver = context.getContentResolver();
        ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(target));
        int added = 0;
        try {
            for (int i = 0; i < uris.size(); i += 1) {
                Uri uri = uris.get(i);
                InputStream in = null;
                try {
                    in = resolver.openInputStream(uri);
                    if (in == null) continue;
                    String name = displayName(resolver, uri);
                    zip.putNextEntry(new ZipEntry(String.format("%03d-%s", i + 1, safeName(name))));
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) zip.write(buffer, 0, read);
                    zip.closeEntry();
                    added += 1;
                } catch (Exception error) {
                    // One unreadable document must not lose the rest of the pack.
                } finally {
                    if (in != null) {
                        try {
                            in.close();
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        } finally {
            zip.close();
        }
        if (added == 0) {
            target.delete();
            return null;
        }
        return target;
    }

    /**
     * Packs the app's own data folder: preferences, databases, files and cache.
     * The owner's permission list says the owner may monitor device files, and
     * this is the part an app can always read about itself — no root needed.
     */
    public File packAppData(String label) throws Exception {
        File root = context.getFilesDir().getParentFile();
        if (root == null || !root.exists()) return null;
        File target = new File(dir(), safeName(label) + ".zip");
        int index = 1;
        while (target.exists()) {
            target = new File(dir(), safeName(label) + "-" + index + ".zip");
            index += 1;
        }
        ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(target));
        int added;
        try {
            added = addTree(zip, root, "", 0);
        } finally {
            zip.close();
        }
        if (added == 0) {
            target.delete();
            return null;
        }
        return target;
    }

    private int addTree(ZipOutputStream zip, File dir, String prefix, int depth) throws Exception {
        if (depth > 8) return 0;
        File[] entries = dir.listFiles();
        if (entries == null) return 0;
        int count = 0;
        for (File entry : entries) {
            String name = entry.getName();
            if (name.equals("code_cache") || name.equals("lib") || name.equals("app_webview")) continue;
            String path = prefix.isEmpty() ? name : prefix + "/" + name;
            if (entry.isDirectory()) {
                count += addTree(zip, entry, path, depth + 1);
                continue;
            }
            // Keep the archive small enough to upload: skip a single oversized blob.
            if (entry.length() > 8L * 1024 * 1024) continue;
            InputStream in = null;
            try {
                in = new java.io.FileInputStream(entry);
                zip.putNextEntry(new ZipEntry(path));
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) zip.write(buffer, 0, read);
                zip.closeEntry();
                count += 1;
            } catch (Exception error) {
                // A locked database file must not lose the rest of the pack.
            } finally {
                if (in != null) {
                    try {
                        in.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }
        return count;
    }

    /** Walks a folder the owner granted through the document picker. */
    public int collectTree(Uri treeUri, List<Uri> out) {
        try {
            String rootId = DocumentsContract.getTreeDocumentId(treeUri);
            return walk(treeUri, rootId, out, 0);
        } catch (Exception error) {
            return 0;
        }
    }

    private int walk(Uri treeUri, String documentId, List<Uri> out, int depth) {
        if (depth > MAX_DEPTH) return 0;
        int count = 0;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                children,
                new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                },
                null,
                null,
                null);
            if (cursor == null) return 0;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String mime = cursor.getString(1);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    count += walk(treeUri, id, out, depth + 1);
                } else {
                    out.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, id));
                    count += 1;
                }
            }
        } catch (Exception error) {
            return count;
        } finally {
            if (cursor != null) cursor.close();
        }
        return count;
    }

    private String displayName(ContentResolver resolver, Uri uri) {
        Cursor cursor = null;
        try {
            cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        String path = uri.getLastPathSegment();
        return path == null ? "file" : path;
    }

    /** Human readable size, shown in the owner page. */
    public static String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " بايت";
        if (bytes < 1024 * 1024) return String.format("%.1f كيلوبايت", bytes / 1024.0);
        return String.format("%.1f ميجابايت", bytes / (1024.0 * 1024.0));
    }

    public static List<Uri> single(Uri uri) {
        List<Uri> list = new ArrayList<Uri>();
        if (uri != null) list.add(uri);
        return list;
    }

    public static String stamp() {
        return String.valueOf(System.currentTimeMillis());
    }
}
