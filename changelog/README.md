# Changelog entries, one file each

A pull request's changelog entry is a new file in this directory. It is not a
new section at the top of `CHANGELOG.md`.

## How

Add one file named `<date>-<slug>.md`, for example
`2026-11-18-relay-refuses-an-unsigned-client.md`:

- `<date>` is the UTC date, `YYYY-MM-DD`.
- `<slug>` is lowercase letters, digits and hyphens, and says what changed.
- The first line is the heading the entry would have had in `CHANGELOG.md`:
  `## 2026-11-18 — Relay: an unsigned client is refused`, with the same date
  as the file name.
- The rest is the entry, written as before.

Do not edit `CHANGELOG.md` to add an entry. `tests/changelog-lint.test.ts`
fails a pull request that adds a `## ` heading there, and names this file.

## Why

Every pull request used to write its entry at the top of `CHANGELOG.md`. Two
pull requests that both insert at the same line conflict, so every merge to
master put every other open pull request into conflict. Each resolution was a
push, and each push restarted every check on that pull request. On 2026-11-17
one pull request took six such pushes, about fifty checks each, before it
could land, while master took a merge every twenty to thirty minutes.

Two different files never conflict.

## Reading the changelog

`CHANGELOG.md` holds every entry up to 2026-11-18. Entries after that are the
files here; sorted by name they are in date order, oldest first.

`tools/changelog-lint.mjs` reads both: a commit hash cited in an entry file is
checked like one cited in `CHANGELOG.md`, and a merge that adds an entry file
counts as documented.
