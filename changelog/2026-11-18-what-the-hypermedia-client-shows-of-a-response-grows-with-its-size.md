## 2026-11-18 — Hypermedia client: what a response is shown as grows with its size

What either client shows of a response now grows with its size, not with a
product of its parts. The page laid a SPARQL result of 1,000 variables and
1,000 empty bindings, 9,934 bytes, out as a million table cells, and a value
one variable named 1,000 times once in each column; JSON nested 255 deep was
indented to 5 MB for 20 KB in both clients, and so was an MCP payload a dry
run shows. A layout may add 8 units for each byte, 10,000 at least, or the
response is shown as its text after a note saying why, and JSON a client
writes of its own is written unindented. A response is read to 8 MiB.

The page's table now finds each row's values by the row's own keys, through
a map of its columns built once, rather than looking each variable's name up
in each row, which cost the name's length every time: 50 names of 4,000
characters over 80,000 empty bindings, 440 KB, took 22 s to be shown as
text, and now take 0.2 s. Each cell, row and head cell also counts 9 units,
the markup of an empty cell, so a table has fewer elements than its response
has bytes: 400 by 400 empty bindings after 20 KB of whitespace were 160,000
cells. hmc.py's --json gives a response's note only when it has one.
