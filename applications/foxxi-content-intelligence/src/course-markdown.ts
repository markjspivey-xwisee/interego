/**
 * Course text as HTML: a safe subset of Markdown.
 *
 * A course section is written in Markdown because both of its readers take it natively: an agent
 * reads the source as it is, and a person reads this rendering. Supported: headings, paragraphs
 * (a single line break stays a break), bullet and numbered lists, block quotes, fenced code,
 * tables, horizontal rules, images, links (with the typed-link metadata `{rel="…" type="…"}`),
 * inline code, bold and italics.
 *
 * ★ NOTHING THE AUTHOR WRITES BECOMES MARKUP BY ITSELF. Every character of text is escaped, and
 * the only elements produced are the ones this file builds. A URL becomes a link or an image only
 * when it is http(s) without credentials; anything else stays as escaped text. No attribute is
 * copied from the source except an escaped link `rel`/`type`, image `alt`, and a code `language-`
 * class drawn from [A-Za-z0-9+-].
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** How deeply block quotes may nest before the rest is shown as text. */
const MAX_QUOTE_DEPTH = 4;

/** A URL a course may link to or show: http(s) without credentials, else null. */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Inline markup: code spans, images, typed links, bold and italics. The rest is escaped text. */
export function courseInlineHtml(text: string): string {
  // Emphasis needs no space just inside its markers, as CommonMark's flanking rule has it, so
  // "2 * 3 * 4" stays arithmetic; an underscore inside a word (snake_case) is not emphasis.
  const token = /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^\s)]+)\)|\[([^\]\n]+)\]\(([^\s)]+)\)(?:\{([^{}\n]*)\})?|\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*|(?<![\w])__(?!\s)([^_\n]+?)(?<!\s)__(?![\w])|\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<![\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w])/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(token)) {
    out += esc(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) { out += `<code>${esc(m[1])}</code>`; continue; }
    if (m[3] !== undefined) {
      const src = safeUrl(m[3]);
      out += src ? `<img src="${esc(src)}" alt="${esc(m[2] ?? '')}" loading="lazy">` : esc(m[0]);
      continue;
    }
    if (m[5] !== undefined) {
      const href = safeUrl(m[5]);
      if (!href) { out += esc(m[0]); continue; }
      const attrs = m[6] ?? '';
      const rel = /(?:^|\s)rel=["']([^"']*)["']/.exec(attrs)?.[1] ?? 'related';
      const type = /(?:^|\s)type=["']([^"']*)["']/.exec(attrs)?.[1];
      out += `<a href="${esc(href)}" rel="${esc(rel)} noopener noreferrer" target="_blank"${type ? ` type="${esc(type)}"` : ''}>${esc(m[4] ?? '')}</a>`;
      continue;
    }
    if (m[7] !== undefined || m[8] !== undefined) { out += `<strong>${courseInlineHtml(m[7] ?? m[8] ?? '')}</strong>`; continue; }
    out += `<em>${courseInlineHtml(m[9] ?? m[10] ?? '')}</em>`;
  }
  return out + esc(text.slice(last));
}

const FENCE = /^\s*(```|~~~)\s*([A-Za-z0-9+-]*)[^\n]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

/** Split a table row at its unescaped pipes; `\|` is a literal pipe. */
function tableCells(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
  return cells.map(cell => cell.replace(/\\\|/g, '|').trim());
}

/** A table starts at a row with pipes over a delimiter row (with a pipe) of as many cells, as in GFM. */
function startsTable(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && next.includes('|') && TABLE_SEPARATOR.test(next)
    && tableCells(line).length === tableCells(next).length;
}

/** Does this line start a block that ends a paragraph? */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line)
    || startsTable(line, next);
}

function renderBlocks(markdown: string, depth: number): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      html.push(`<pre><code${fence[2] ? ` class="language-${esc(fence[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // The section title is the page's heading, so a section's own headings start one level down.
      const level = Math.min(6, heading[1]!.length + 1);
      html.push(`<h${level}>${courseInlineHtml(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) { html.push('<hr>'); i++; continue; }

    if (startsTable(line, lines[i + 1])) {
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]!).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
      const style = (c: number): string => align[c] ? ` style="text-align:${align[c]}"` : '';
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(tableCells(lines[i++]!));
      html.push(`<table><thead><tr>${head.map((cell, c) => `<th${style(c)}>${courseInlineHtml(cell)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map(row => `<tr>${head.map((_, c) => `<td${style(c)}>${courseInlineHtml(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(QUOTE.exec(lines[i++]!)![1]!);
      html.push(depth < MAX_QUOTE_DEPTH
        ? `<blockquote>${renderBlocks(inner.join('\n'), depth + 1)}</blockquote>`
        : `<blockquote><p>${inner.map(courseInlineHtml).join('<br>')}</p></blockquote>`);
      continue;
    }

    const bullet = BULLET.test(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const items: string[] = [];
      const itemPattern = bullet ? BULLET : NUMBERED;
      while (i < lines.length && lines[i]!.trim()) {
        const current = lines[i]!;
        const item = itemPattern.exec(current);
        if (item) items.push(bullet ? item[1]! : item[2]!);
        else if (/^\s+\S/.test(current) && items.length) items[items.length - 1] += `\n${current.trim()}`;
        else break;
        i++;
      }
      const start = numbered && numbered[1] !== '1' ? ` start="${Number(numbered[1])}"` : '';
      html.push(`<${bullet ? 'ul' : `ol${start}`}>${items.map(item => `<li>${item.split('\n').map(courseInlineHtml).join('<br>')}</li>`).join('')}</${bullet ? 'ul' : 'ol'}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (!paragraph.length || !startsBlock(lines[i]!, lines[i + 1]))) paragraph.push(lines[i++]!.trim());
    html.push(`<p>${paragraph.map(courseInlineHtml).join('<br>')}</p>`);
  }
  return html.join('\n');
}

/** A course section's Markdown as safe HTML. */
export function courseMarkdownHtml(markdown: string): string {
  return renderBlocks(String(markdown ?? ''), 0);
}
