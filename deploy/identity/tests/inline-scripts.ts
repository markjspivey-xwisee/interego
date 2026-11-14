/**
 * The inline scripts of a page this server rendered, by position and not by pattern: the text
 * between each `<script>` and the `</script>` that follows it. The pages under test are this
 * server's own templates, whose tags are written exactly so; a page with any other spelling of the
 * tag has no script here, and the tests that count scripts fail on it.
 */
export function inlineScripts(html: string): string[] {
  const open = '<script>', close = '</script>';
  const found: string[] = [];
  for (let from = html.indexOf(open); from !== -1; from = html.indexOf(open, from)) {
    const start = from + open.length;
    const end = html.indexOf(close, start);
    if (end === -1) break;
    found.push(html.slice(start, end));
    from = end + close.length;
  }
  return found;
}
