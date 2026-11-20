## 2026-11-20 — Practice Evidence: the hosted service now holds model keys, by the owner's decision

The README said the hosted service "holds no model key and never will". The
owner reversed that on 2026-11-20, for live voice calls.

The hosted service now holds a speech key, without which no live call can be
placed, and a key for the bridge's own model, so a saved call can be judged
before a person reviews it. The bridge's own model is lent only to principals
holding a role on the pod, and it is the same route that plays the other person
in typed practice and drafts scenarios. A judgment it makes discloses the
provider, the model and that the key was the bridge's.

The README, the provisioning tool's header and a comment in the web app said
otherwise and are corrected. The provisioning tool still never writes a model
setting: a person sets them. People who bring their own assistant are unaffected.
