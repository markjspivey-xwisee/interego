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
the markup of an empty cell: 400 by 400 empty bindings after 20 KB of
whitespace were 160,000 cells. hmc.py's --json gives a response's note only
when it has one.

A descriptor's answer is now read to 8 MiB too, in both clients, whatever its
status: one longer is not read, and the request ends as one that gets no
answer does, named, so a ?format=jsonld retry answered so leaves the first
answer read.

A table now has a bound of its own, as jsdom builds an element in about 17 us
and the time rule allows 12.5 us for each byte: one element for each 8 bytes,
and 30,000 at least, a cell that shows anything counting two, and no more
characters than the response has bytes. Small honest results that bind
little, as unmatched OPTIONALs leave them, are tables again: 2 variables by
370 empty bindings had become text. 100 variables of empty bindings padded to
256 KiB took 4.1 s against 3.3 s at the old bound, and 0.6 s at the new one.

A descriptor's answer that is not 2xx is no longer read at all, and a 2xx one
past 8 MiB does not count, so the formats are asked as before: an 8 MiB 404 or
HTML page with JSON-LD at ?format=jsonld ended the load, and a 404 whose body
never ends held it. hmc.py took a body cut short of its Content-Length as
whole, listing two of a document's four controls; it now names it, as the
page's fetch fails on it, for loads and invokes alike.

The page's table now counts each part for what it builds, so its bound holds
for links too: a row and a cell one element each, a cell that shows a name or
a value one more, and one that shows an https link three more. The 9 units a
cell once counted are gone, and its characters may reach 10,000 however small
the response. 1,000 columns named "a", filled with links by 523 bindings of
8 MiB, took 45 s against 105 s; at the new bound such a table takes 17 s, and
the costliest table at 8 MiB 20 s.
