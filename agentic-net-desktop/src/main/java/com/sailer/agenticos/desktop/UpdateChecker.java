package com.sailer.agenticos.desktop;

import java.io.IOException;
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
 *
 * <p>{@link #checkNow} is the same question asked on demand, for the tray's
 * "Check for Updates" item — which must not depend on the daily cycle having
 * happened to run since the release was published.
 */
public final class UpdateChecker {

    private static final String LATEST_API =
        "https://api.github.com/repos/alexejsailer/agentic-nets/releases/latest";
    private static final Pattern TAG = Pattern.compile("\"tag_name\"\\s*:\\s*\"v?([0-9][0-9.]*)\"");

    private UpdateChecker() {
    }

    /**
     * Ask GitHub once. Returns the newer version, or {@code null} when this build is current.
     *
     * <p>"Up to date" (null) and "could not ask" (exception) are deliberately different
     * outcomes: a caller that collapses them tells the user they are current when the truth
     * is that the network failed.
     */
    public static String checkNow(String currentVersion) throws IOException, InterruptedException {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        HttpResponse<String> response = http.send(
            HttpRequest.newBuilder(URI.create(LATEST_API))
                .header("Accept", "application/vnd.github+json")
                .timeout(Duration.ofSeconds(10)).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("GitHub returned HTTP " + response.statusCode());
        }
        return newerVersionFrom(response.body(), currentVersion);
    }

    /** The newer version named by a /releases/latest body, or null when it is not newer. */
    static String newerVersionFrom(String body, String currentVersion) {
        Matcher m = TAG.matcher(body == null ? "" : body);
        return m.find() && isNewer(m.group(1), currentVersion) ? m.group(1) : null;
    }

    /** Calls {@code onUpdate} with the newer version string when one exists. */
    public static void start(String currentVersion, Consumer<String> onUpdate) {
        if (currentVersion == null || currentVersion.isBlank() || "dev".equals(currentVersion)) {
            return;
        }
        Thread.ofVirtual().start(() -> {
            while (true) {
                try {
                    String newer = checkNow(currentVersion);
                    if (newer != null) {
                        onUpdate.accept(newer);
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
