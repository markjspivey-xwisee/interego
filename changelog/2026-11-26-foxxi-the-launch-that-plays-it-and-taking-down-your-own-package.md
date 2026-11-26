## 2026-11-26 — Foxxi: the launch that plays the course, and taking down a package you brought

- **The pair read offers the launch that works.** `POST /agent/learning/beside`
  offered the cmi5 launch for every course, which answered 404 for a course the
  SCORM engine plays. Each course now says what plays it (`playedBy`) and gives
  that launch, or `launchWhy` when nothing on the bridge plays it now.
- **Whoever brought a package can take it down**
  (`POST /agent/scorm/host/remove`, `foxxi.take_down_own_package_signed`,
  `src/package-bringers.ts`). Only when it is theirs alone: no other signer
  brought the same bytes, no operator keeps it, and it was not already hosted
  before they brought it. Who brought what is recorded on the pod as packages
  arrive. A package brought before this record existed has no recorded bringer
  and stays an admin's to remove.
- **An assignment names how to tell the agent** (`tell`: the Interego inbox).
  The bridge still sends nothing itself.
- **A write route is an affordance**
  (`tests/a-write-route-is-an-affordance.test.ts`). A ratchet: every write
  route `bridge/server.ts` mounts is offered in `affordances.ts`, or is on a
  list of 17 that were not on this date, which may only shrink.
