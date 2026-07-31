package com.sailer.agenticos.desktop;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Once at startup and then daily, asks GitHub for the latest release and
 * reports a newer version. Fail-soft: network problems are silently retried
 * on the next cycle; "dev" builds never check.
 */
public final class UpdateChecker {

    private static final String LATEST_API =
        "https://api.github.com/repos/alexejsailer/agentic-nets/releases/latest";
    private static final Pattern TAG = Pattern.compile("\"tag_name\"\\s*:\\s*\"v?([0-9][0-9.]*)\"");

    private UpdateChecker() {
    }

    /** Calls {@code onUpdate} with the newer version string when one exists. */
    public static void start(String currentVersion, Consumer<String> onUpdate) {
        if (currentVersion == null || currentVersion.isBlank() || "dev".equals(currentVersion)) {
            return;
        }
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        Thread.ofVirtual().start(() -> {
            while (true) {
                try {
                    HttpResponse<String> response = http.send(
                        HttpRequest.newBuilder(URI.create(LATEST_API))
                            .header("Accept", "application/vnd.github+json")
                            .timeout(Duration.ofSeconds(10)).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                    if (response.statusCode() == 200) {
                        Matcher m = TAG.matcher(response.body());
                        if (m.find() && isNewer(m.group(1), currentVersion)) {
                            onUpdate.accept(m.group(1));
                        }
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (Exception ignored) {
                    // offline or rate-limited — try again next cycle
                }
                try {
                    Thread.sleep(TimeUnit.HOURS.toMillis(24));
                } catch (InterruptedException e) {
                    return;
                }
            }
        });
    }

    static boolean isNewer(String candidate, String current) {
        String[] a = candidate.split("\\.");
        String[] b = current.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? parse(a[i]) : 0;
            int y = i < b.length ? parse(b[i]) : 0;
            if (x != y) {
                return x > y;
            }
        }
        return false;
    }

    private static int parse(String part) {
        try {
            return Integer.parseInt(part.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
