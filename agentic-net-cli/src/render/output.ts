import chalk from 'chalk';
import Table from 'cli-table3';
import ora, { type Ora } from 'ora';

export type OutputFormat = 'text' | 'json';

let _format: OutputFormat = process.stdout.isTTY ? 'text' : 'json';
let _noColor = false;

export function setOutputFormat(format: OutputFormat): void {
  _format = format;
}

export function setNoColor(value: boolean): void {
  _noColor = value;
}

export function getOutputFormat(): OutputFormat {
  return _format;
}

export function isJsonMode(): boolean {
  return _format === 'json';
}

// ---- JSON output ----

export function outputJson(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

// ---- Text output ----

export function outputSuccess(message: string): void {
  if (isJsonMode()) return;
  console.log(_noColor ? `OK: ${message}` : chalk.green(`✓ ${message}`));
}

export function outputError(message: string): void {
  if (isJsonMode()) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(_noColor ? `ERROR: ${message}` : chalk.red(`✗ ${message}`));
  }
}

export function outputWarn(message: string): void {
  if (isJsonMode()) return;
  console.log(_noColor ? `WARN: ${message}` : chalk.yellow(`⚠ ${message}`));
}

export function outputInfo(message: string): void {
  if (isJsonMode()) return;
  console.log(_noColor ? message : chalk.cyan(message));
}

export function outputDim(message: string): void {
  if (isJsonMode()) return;
  console.log(_noColor ? message : chalk.dim(message));
}

// ---- Tables ----

export function outputTable(headers: string[], rows: string[][]): void {
  if (isJsonMode()) {
    const result = rows.map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? '';
      });
      return obj;
    });
    outputJson(result);
    return;
  }

  const table = new Table({
    head: _noColor ? headers : headers.map(h => chalk.bold(h)),
    style: { head: [], border: [] },
  });
  for (const row of rows) {
    table.push(row);
  }
  console.log(table.toString());
}

// ---- Spinner ----

export function createSpinner(text: string): Ora {
  return ora({ text, isSilent: isJsonMode() });
}

// ---- Agent event rendering ----

export function renderThinking(text: string): void {
  if (isJsonMode()) return;
  console.log(_noColor ? `[think] ${text}` : chalk.dim(`[think] ${text}`));
}

export function renderToolCall(tool: string, input?: any): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ type: 'tool_call', tool, input }));
    return;
  }
  const inputStr = input ? ` → ${truncate(JSON.stringify(input), 120)}` : '';
  console.log(_noColor ? `[tool] ${tool}${inputStr}` : chalk.blue(`[tool] ${tool}`) + chalk.dim(inputStr));
}

export function renderToolResult(tool: string, result: any): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ type: 'tool_result', tool, result }));
    return;
  }
  const resultStr = truncate(typeof result === 'string' ? result : JSON.stringify(result), 200);
  console.log(_noColor ? `[result] ${tool}: ${resultStr}` : chalk.green(`[result] ${tool}: `) + chalk.dim(resultStr));
}

export function renderAssistantText(text: string): void {
  if (isJsonMode()) {
    console.log(JSON.stringify({ type: 'text', content: text }));
    return;
  }
  console.log(text);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
