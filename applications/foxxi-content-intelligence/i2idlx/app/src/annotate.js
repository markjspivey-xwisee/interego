// Find I2IDL terms in any text: the build's surface forms (labels, alternate labels, acronyms), longest first,
// so a longer label wins over a shorter one inside it. Plain JS so the logic check can run it under node.
import { FORMS } from "./data.js";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let compiled = null;
function patterns() {
  // FORMS arrive longest first, so a longer label wins over a shorter one inside it
  if (!compiled) compiled = FORMS.map(([form, ci, strong, cs]) => ({ re: new RegExp("(?<![\\w-])" + esc(form) + "(?![\\w-])", cs ? "g" : "gi"), ci, strong: !!strong, form }));
  return compiled;
}

export function annotate(text, weak) {
  const taken = new Uint8Array(text.length);
  const spans = [];
  for (const p of patterns()) {
    if (!p.strong && !weak) continue;
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const a = m.index, b = a + m[0].length;
      let free = true;
      for (let i = a; i < b; i++) if (taken[i]) { free = false; break; }
      if (free) { taken.fill(1, a, b); spans.push([a, b, p.ci]); }
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  return spans.sort((x, y) => x[0] - y[0]);
}
