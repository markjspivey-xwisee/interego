## 2026-11-18 — Changelog: an entry is its own file, so open pull requests stop conflicting

Every pull request wrote its entry at the top of `CHANGELOG.md`. Two pull
requests that both insert at the same line conflict, so every merge to master
put every other open pull request into conflict. Each resolution was a push,
and each push restarted every check on that pull request.

Measured on 2026-11-17, while master took a merge every twenty to thirty
minutes: #950 needed six pushes whose only content was a changelog merge, and
#951 five, each restarting about fifty checks, before either could land. The
first audit of where CI time goes missed this, because it counted re-runs (3
in 1000 runs) and not pushes made only to resolve the changelog.

An entry is now a file under `changelog/`, named `<date>-<slug>.md`, with the
heading it would have had as its first line. `changelog/README.md` is the
convention. `CHANGELOG.md` keeps every entry up to now and takes no new ones.

**What enforces it.** `tests/changelog-lint.test.ts` fails a pull request that
adds a `## ` heading to `CHANGELOG.md`, measured against its merge-base with
master, and says to move the entry to a file. It also holds each entry file to
its name and heading. It runs in the pull request's suite only, so a pull
request opened before this that lands with an entry in `CHANGELOG.md` does not
turn master red.

**What an open pull request has to do.** One that already has an entry at the
top of `CHANGELOG.md` fails that test the next time it takes master in. Move
the entry, unchanged, into a file here and restore `CHANGELOG.md` to master's.
That is the last changelog conflict it will have.

**The gate follows the entries.** `tools/changelog-lint.mjs` reads the entry
files with `CHANGELOG.md` when it checks cited commit hashes, and counts a
merge that adds an entry file as documented. Without the second, every merge
from here on would have counted against the undocumented backlog.

Bridge Typecheck's trigger now includes `changelog/**`, because its suite
reads the directory.

**Not verified.** That GitHub merges two pull requests that each add a file
here without conflict is how git works, but no two have done it yet.
