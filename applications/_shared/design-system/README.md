# Interego design system

One stylesheet, `design-system.css`, shared by the Work Redesign and Practice Evidence web apps. Each bridge serves it at the head of `/ui/app.css`, followed by its own product rules, and picks its accent with a class on `<body>`: `product-wrd` (teal) or `product-pev` (indigo).

It must stay safe under the bridges' Content-Security-Policy (`style-src 'self'`, no `font-src`): no `@import`, no web fonts and no remote `url()`. `designSystemCss()` in `index.ts` reads it once.
