## 2026-11-20 — Foxxi: a cmi5 package's unit may be served from an address the operator approved

A unit that holds a live voice call was launched from a hosted package on the
deployed bridge and was refused its microphone. Every file of a hosted package
is served in a sandbox with an opaque origin, so that nothing of the bridge's is
a package's own, and a browser gives a page in that state no microphone and no
camera. The sandbox is right and stays.

cmi5 lets a course structure give a unit an absolute address. A hosted cmi5
package may now do that: the unit is served by whoever serves the address, in
that address's own origin. It is a unit of the course only while the operator
approves its address, in `FOXXI_CMI5_OUTSIDE_AU_PREFIXES`: https addresses
ending in `/`, and a unit is approved when its address begins with one. Unset,
no unit is served from outside, as before.

A package whose only units are at addresses not approved is not hosted, and the
answer names them. Approving a place lets a page there act in a learner's
session for the registration it was launched for, as cmi5 has an LMS do for any
unit; anyone who signs can bring a package naming a page under an approved
place.

Not done: the deployed bridge's setting, which is the operator's. The player's
speech recognition in the scripted practice has the same limit when launched
from a hosted package; this change is what lets a course avoid it, and no
existing course is changed.
