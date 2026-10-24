package ru.crashtest.app;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Передаёт только созданный приложением отчёт из закрытого кэша. */
@CapacitorPlugin(name = "ReportShare")
public class ReportSharePlugin extends Plugin {
    @PluginMethod
    public void share(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.length() > 16 * 1024 * 1024) {
            call.reject("Неверный размер отчёта");
            return;
        }
        try {
            File directory = new File(getContext().getCacheDir(), "reports");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException();
            File[] old = directory.listFiles();
            if (old != null) for (File item : old) {
                if (item.lastModified() < System.currentTimeMillis() - 86400000L) item.delete();
            }
            File file = File.createTempFile("crashtest-", ".html", directory);
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(html.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/html");
            intent.putExtra(Intent.EXTRA_SUBJECT, "Разбор Crashtest");
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.setClipData(ClipData.newRawUri("Разбор Crashtest", uri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(Intent.createChooser(intent, "Поделиться отчётом"));
                    call.resolve();
                } catch (Exception error) {
                    call.reject("Не удалось открыть панель отправки", error);
                }
            });
        } catch (Exception error) {
            call.reject("Не удалось сохранить отчёт", error);
        }
    }
}
