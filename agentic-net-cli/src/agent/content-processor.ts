/**
 * Content processing utilities for EXTRACT_TOKEN_CONTENT tool.
 * Provides regex-based extraction modes (text, links, structure, head)
 * and helpers for LLM-based summarization (chunking, HTML stripping).
 */

/** Detect content type from raw string. */
export function detectContentType(raw: string): 'html' | 'json' | 'text' {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('<') && (trimmed.includes('</') || trimmed.includes('/>'))) return 'html';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not json */ }
  }
  return 'text';
}

/** Strip HTML tags, scripts, styles, and decode common entities. */
export function stripHtml(html: string): string {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code)));
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Extract all links from HTML. */
export function extractLinks(html: string): { url: string; text: string }[] {
  const links: { url: string; text: string }[] = [];
  const regex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    links.push({
      url: match[1],
      text: match[2].replace(/<[^>]+>/g, '').trim(),
    });
  }
  return links;
}

/** Extract structural elements from HTML: title, headings, forms, tables. */
export function extractStructure(html: string): {
  title?: string;
  headings: { level: number; text: string }[];
  formActions: string[];
  tableHeaders: string[][];
} {
  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : undefined;

  // Headings
  const headings: { level: number; text: string }[] = [];
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(html)) !== null) {
    headings.push({
      level: parseInt(hMatch[1]),
      text: hMatch[2].replace(/<[^>]+>/g, '').trim(),
    });
  }

  // Form actions
  const formActions: string[] = [];
  const formRegex = /<form[^>]*action=["']([^"']+)["'][^>]*>/gi;
  let fMatch;
  while ((fMatch = formRegex.exec(html)) !== null) {
    formActions.push(fMatch[1]);
  }

  // Table headers
  const tableHeaders: string[][] = [];
  const theadRegex = /<thead[\s\S]*?<\/thead>/gi;
  let tMatch;
  while ((tMatch = theadRegex.exec(html)) !== null) {
    const headers: string[] = [];
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thMatch;
    while ((thMatch = thRegex.exec(tMatch[0])) !== null) {
      headers.push(thMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (headers.length > 0) tableHeaders.push(headers);
  }

  return { title, headings, formActions, tableHeaders };
}

/** Summarize JSON: top-level keys, array lengths, first item preview. */
export function summarizeJson(json: string, limit: number): string {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      const preview = parsed.length > 0 ? JSON.stringify(parsed[0]).slice(0, 200) : 'empty';
      return `Array[${parsed.length}] — first item: ${preview}`;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      const summary: string[] = [`Object with ${keys.length} keys: ${keys.join(', ')}`];
      for (const key of keys.slice(0, 5)) {
        const val = parsed[key];
        if (Array.isArray(val)) {
          summary.push(`  ${key}: Array[${val.length}]`);
        } else if (typeof val === 'object' && val !== null) {
          summary.push(`  ${key}: Object{${Object.keys(val).join(', ')}}`);
        } else {
          summary.push(`  ${key}: ${String(val).slice(0, 100)}`);
        }
      }
      return summary.join('\n').slice(0, limit);
    }
    return String(parsed).slice(0, limit);
  } catch {
    return json.slice(0, limit);
  }
}

/** Split text into chunks at sentence boundaries. */
export function chunkText(text: string, chunkSize: number = 15000): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('. ', end);
      if (lastPeriod > start + chunkSize * 0.5) {
        end = lastPeriod + 2;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export type ContentMode = 'summarize' | 'text' | 'links' | 'structure' | 'head';

export interface ContentResult {
  mode: ContentMode;
  contentType: string;
  originalLength: number;
  [key: string]: any;
}

/**
 * Process raw content with the specified regex mode.
 * For 'summarize' mode, call this to get the preprocessed text, then use LLM externally.
 */
export function processContent(raw: string, mode: ContentMode, limit: number = 4000): ContentResult {
  const contentType = detectContentType(raw);
  const base = { mode, contentType, originalLength: raw.length };

  switch (mode) {
    case 'text': {
      const text = contentType === 'html' ? stripHtml(raw) : raw;
      return { ...base, text: text.slice(0, limit), truncated: text.length > limit };
    }
    case 'links': {
      if (contentType !== 'html') return { ...base, links: [], note: 'Content is not HTML' };
      const links = extractLinks(raw);
      return { ...base, linkCount: links.length, links: links.slice(0, 50) };
    }
    case 'structure': {
      if (contentType !== 'html') return { ...base, note: 'Content is not HTML' };
      const structure = extractStructure(raw);
      return { ...base, ...structure };
    }
    case 'head': {
      const head = raw.slice(0, limit);
      const tail = raw.length > limit ? raw.slice(-200) : '';
      return { ...base, head, tail: tail || undefined, truncated: raw.length > limit };
    }
    case 'summarize': {
      // For summarize, return preprocessed text — caller handles LLM calls
      if (contentType === 'json') {
        return { ...base, summary: summarizeJson(raw, limit) };
      }
      const plainText = contentType === 'html' ? stripHtml(raw) : raw;
      return { ...base, plainText, plainTextLength: plainText.length };
    }
    default:
      return { ...base, error: `Unknown mode: ${mode}` };
  }
}
