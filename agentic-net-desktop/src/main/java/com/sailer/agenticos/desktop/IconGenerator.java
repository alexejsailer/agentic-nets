package com.sailer.agenticos.desktop;

import javax.imageio.ImageIO;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.GradientPaint;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.QuadCurve2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Renders the AgenticNets brand mark into the platform icon formats the
 * installers need. Build-time only — run from the packaging scripts.
 *
 *   AgenticNetOS.ico        app + installer icon (multi-resolution)
 *   icon_NNxNN.png          source set, also used to build the macOS .icns
 *   installerbanner.bmp     MSI dialog banner  (493x58)
 *   installersidebar.bmp    MSI welcome panel  (493x312)
 *
 * The mark matches .github/images/agentic-nets-icon.svg: a rounded dark tile
 * with three connected places — white outer nodes, a raised cyan middle node,
 * two cyan arcs through it and a fainter arc closing the triangle.
 */
public final class IconGenerator {

    private static final Color TILE_TOP = new Color(0x1A2F4A);
    private static final Color TILE_BOTTOM = new Color(0x2A4A6F);
    private static final Color EDGE = new Color(0x4A9EFF);
    private static final Color ACCENT = new Color(0x4AFFEF);
    private static final int[] ICO_SIZES = { 16, 24, 32, 48, 64, 128, 256 };

    private IconGenerator() {
    }

    public static void main(String[] args) throws IOException {
        Path out = Path.of(args.length > 0 ? args[0] : "icons");
        Files.createDirectories(out);

        for (int size : ICO_SIZES) {
            ImageIO.write(mark(size, true), "png", out.resolve("icon_" + size + "x" + size + ".png").toFile());
        }
        writeIco(out.resolve("AgenticNetOS.ico"), ICO_SIZES);
        ImageIO.write(banner(493, 58), "bmp", out.resolve("installerbanner.bmp").toFile());
        ImageIO.write(sidebar(493, 312), "bmp", out.resolve("installersidebar.bmp").toFile());
        System.out.println("icons written to " + out.toAbsolutePath());
    }

    /** The brand tile at an arbitrary size; {@code tile=false} draws the mark alone. */
    static BufferedImage mark(int size, boolean tile) {
        BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        double s = size / 32.0; // the SVG is authored on a 32-unit grid

        if (tile) {
            g.setPaint(new GradientPaint(0, 0, TILE_TOP, size, size, TILE_BOTTOM));
            g.fill(new RoundRectangle2D.Double(2 * s, 2 * s, 28 * s, 28 * s, 6 * s, 6 * s));
            g.setColor(EDGE);
            g.setStroke(new BasicStroke((float) (1.5 * s)));
            g.draw(new RoundRectangle2D.Double(2 * s, 2 * s, 28 * s, 28 * s, 6 * s, 6 * s));
        }

        // arcs first so the nodes sit on top
        g.setColor(ACCENT);
        g.setStroke(new BasicStroke((float) (1.4 * s), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(new QuadCurve2D.Double(10 * s, 16 * s, 13 * s, 13 * s, 16 * s, 12 * s));
        g.draw(new QuadCurve2D.Double(16 * s, 12 * s, 19 * s, 13 * s, 22 * s, 16 * s));
        g.setColor(new Color(0x2A9EFF));
        g.setStroke(new BasicStroke((float) (1.1 * s), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(new QuadCurve2D.Double(10 * s, 16 * s, 16 * s, 20 * s, 22 * s, 16 * s));

        g.setColor(Color.WHITE);
        fillDot(g, 10 * s, 16 * s, 2.2 * s);
        g.setColor(ACCENT);
        fillDot(g, 16 * s, 12 * s, 2.7 * s);
        g.setColor(Color.WHITE);
        fillDot(g, 22 * s, 16 * s, 2.2 * s);
        g.dispose();
        return image;
    }

    private static void fillDot(Graphics2D g, double cx, double cy, double r) {
        g.fill(new java.awt.geom.Ellipse2D.Double(cx - r, cy - r, r * 2, r * 2));
    }

    /** MSI top banner: mark on the right, wordmark on the left, per WixUI layout. */
    private static BufferedImage banner(int w, int h) {
        BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setPaint(new GradientPaint(0, 0, TILE_TOP, w, h, TILE_BOTTOM));
        g.fillRect(0, 0, w, h);
        g.setColor(Color.WHITE);
        g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 18));
        g.drawString("AgenticNetOS", 20, 28);
        g.setColor(new Color(0xB8D4F0));
        g.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 11));
        g.drawString("Desktop Lite — nets, schedules and MCP on your machine", 20, 45);
        g.drawImage(mark(48, false), w - 60, 5, null);
        g.dispose();
        return image;
    }

    /** MSI welcome/finish sidebar. */
    private static BufferedImage sidebar(int w, int h) {
        BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setPaint(new GradientPaint(0, 0, TILE_TOP, 0, h, TILE_BOTTOM));
        g.fillRect(0, 0, w, h);
        // WixUI overlays its own title and body text on the right of this bitmap,
        // so everything we draw stays inside the left ~165px strip.
        g.drawImage(mark(110, false), 28, h / 2 - 75, null);
        g.setColor(new Color(0xB8D4F0));
        g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 15));
        g.drawString("AgenticNetOS", 30, h / 2 + 55);
        g.dispose();
        return image;
    }

    /**
     * Minimal ICO container. Entries hold PNG payloads, which Windows has
     * accepted since Vista and which keeps 256px icons small.
     */
    static void writeIco(Path target, int[] sizes) throws IOException {
        List<byte[]> pngs = new java.util.ArrayList<>();
        for (int size : sizes) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            ImageIO.write(mark(size, true), "png", buf);
            pngs.add(buf.toByteArray());
        }
        try (OutputStream out = Files.newOutputStream(target)) {
            out.write(le(ByteBuffer.allocate(6).putShort((short) 0).putShort((short) 1)
                .putShort((short) sizes.length)));
            int offset = 6 + 16 * sizes.length;
            for (int i = 0; i < sizes.length; i++) {
                int dim = sizes[i] >= 256 ? 0 : sizes[i]; // 0 encodes 256
                ByteBuffer e = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN);
                e.put((byte) dim).put((byte) dim).put((byte) 0).put((byte) 0);
                e.putShort((short) 1).putShort((short) 32);
                e.putInt(pngs.get(i).length).putInt(offset);
                out.write(e.array());
                offset += pngs.get(i).length;
            }
            for (byte[] png : pngs) {
                out.write(png);
            }
        }
    }

    private static byte[] le(ByteBuffer b) {
        byte[] a = b.array();
        // header fields are little-endian; rebuild since ByteBuffer defaulted to big
        return new byte[] { a[1], a[0], a[3], a[2], a[5], a[4] };
    }
}
