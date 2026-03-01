/**
 * Split long messages to respect Telegram's 4096 character limit.
 * Splits at paragraph boundaries, then newlines, then hard-cuts.
 */

const TELEGRAM_MAX_LENGTH = 4096;

export function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try splitting at double newline (paragraph boundary)
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);

    // Try single newline
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }

    // Try sentence boundary (". ")
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf('. ', maxLength);
      if (splitIndex > 0) splitIndex += 1; // Include the period
    }

    // Try space
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }

    // Hard cut as last resort
    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter(c => c.length > 0);
}
