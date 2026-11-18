## 2026-11-18 — Hypermedia client: a result too large for a table is shown as JSON

Past the table's bound the page shows the result as JSON, as hmc.py does,
indented by the same rule, and past that as its text. It showed the
response's text after its note, and a result written on one line, as most
endpoints write one, was shown as one line: 64 KB long for 16,000 bindings.
The note now ends "it is shown as JSON", and a result past both bounds is
shown as its text after both notes, the table's first.

Both clients now write a response shown as JSON as the same text, the one
JSON.stringify(value, null, 2) writes. hmc.py's text mode wrote it with
json.dumps, so text past ASCII came out as \u escapes, 1.0 stayed 1.0, 1e20
came out as 1e+20, and a key such as "1" stayed where the response put it,
where the page writes it first. It now writes what the page shows.

The JSON is linear in the response: the largest test result, 400,000 empty
bindings in 2 MB, is 4.8 MB of indented JSON, shown in under 0.8 s, and a
refused result of 8 MiB takes at most 18 s of the 105 s its size allows.
