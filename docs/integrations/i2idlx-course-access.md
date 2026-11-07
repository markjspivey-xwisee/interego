# Course access in Ask

Ask supports three explicit access modes. The provider advertises which modes it can actually deliver; the workbench never substitutes a package export for a source-side query.

| Mode | What Foxxi receives and retains | Permission and deletion |
| --- | --- | --- |
| Read when I ask | A SCORM Cloud package export in request memory; only selected passages are sent to the paired agent. No retained course cache. | Explicit course/version permission assertion. Disconnect ends access. |
| Temporary local content graph | The first export is parsed in memory. Instructional text and a graph of published sections, folders and order remain in this browser connection's server session; raw ZIP/media are not retained. | Explicit owner or owner-authorized assertion, selected expiry up to 30 minutes and no later than the paired session. Delete/revoke removes the local text and graph and cancels in-flight retrieval. |
| Query at source | A compatible provider executes retrieval against its own course and optional graph, returning only bounded question passages and graph evidence. No package/export operation or local course cache exists in this mode. | A current source-issued grant for the actor, course and version is checked on every question. Owner policy can revoke it. External derived-content deletion is pending until the provider confirms completion. |

These are temporary connections, not a persistent content library. Neither account credentials nor course IDs are application defaults. The local graph expresses published structure and lexical matches; it does not invent semantic prerequisites or certify learning. A provider can supply a richer graph from its own index.

## Using the page

1. Connect an active AI agent to the workbench.
2. Open **Ask about a course**, select SCORM Cloud or **Course source service**, and supply your own connection details. Source service credentials must come from that provider's authenticated integration, not an LTI launch URL.
3. Select the listed course/version and an advertised mode. Confirm that you own the course or have the owner's permission for this use, then grant temporary access. A browser assertion is recorded as an assertion; it is not independently verified ownership.
4. Ask a question. The source panel identifies the mode, source/version, permission expiry, cache use and graph provenance, alongside the actual cited passages.
5. Delete local content or revoke access when finished. For a compatible external source, **Request deletion at source** removes local artifacts immediately and separately displays the provider's derived-content deletion receipt. Check its status to distinguish pending from completed. This action never deletes the original course.

Deletion prevents future application reuse and late results from restoring the local cache/history. It does not recall passages already sent to an AI client or erase that client's conversations. Owners should allow that sharing explicitly in their source grant. Managed retention outside this session requires a separate owner-controlled storage and deletion integration; it is not silently enabled here.

Stopping a question cancels that retrieval without deleting a still-valid cache or permission. A failed access recheck that revokes permission clears the visible course context immediately; a rejected Cloud credential also clears the connection and shows the reconnect form.

## Source service protocol

The implementation is `src/i2idlx-course-provider.ts` and the source-side adapter is `src/i2idlx-course-source-service.ts` under `applications/foxxi-content-intelligence/`.

The provider supplies one exact public HTTPS endpoint and an opaque, scoped bearer credential through its authenticated UI. Credentials never belong in URLs. All operations POST bounded JSON to that same endpoint with `protocol: "i2idlx-course-source/1"`, `operation` and `actor`. Redirects, non-public destinations, mixed public/private DNS answers and oversized responses are refused. DNS validation occurs in the actual socket lookup.

- `capabilities`: supported modes and operation names.
- `courses`: only courses accessible through this credential; no guessed course identifiers.
- `permission`: current owner grant binding actor, owner, course/version, expiry and the permissions `read-passages`, `share-with-paired-agent`, and optionally `request-deletion`.
- `context`: question, selected course/version and current grant ID. Returns the same current grant, content fingerprint, bounded instructional sections with exact source locators, and optional bounded graph evidence. Each section explicitly declares `assessment: false`. Source services must exclude assessments, hidden answers and grading material in their own reader; a declaration is not semantic certification.
- `request-deletion`: asks the owner service to remove derived content, not the original course. Carries a stable `idempotency_key` reused for uncertain retries. The source must honor it for external writes across restarts. Returns a scoped receipt marked `pending` or `completed`; completion requires a completion time.
- `deletion-status`: reads the exact receipt again. Failure, unsupported operation and pending are never reported as completed deletion.

Limits: 24 passages, 6,000 UTF-8 bytes each, 72,000 total instructional bytes; graph evidence at most 80 nodes/160 edges; total provider JSON at most 192,000 bytes. Full content fingerprints are supplied by the source; Foxxi does not download the full course to independently recompute them in virtual mode. Source provenance and LTI context are provider attestations, not independent verification by the workbench.

## LTI integration

LTI 1.3 supplies a verified launch context; it does not itself grant a tool arbitrary course-body access or the owner's permission to copy, index or disclose it. The actual content provider must expose the source service or an equivalent authorized adapter beside its content.

For an existing Foxxi-style LTI tool, call `LtiCourseSourceTokens.issueForVerifiedLaunch` only inside the existing `attachLti13Routes` **verified** `onResourceLaunch` callback. The helper requires a trusted launch-to-actor mapping, launch-to-course mapping and separate live owner policy; it never treats an Instructor/Learner role as owner permission. Its token is course/version/user-bound and lasts at most 30 minutes. Deliver the credential through the source's authenticated UI, never a redirect/query/fragment or a public descriptor.

Mount `attachCourseSourceService` beside the course with callbacks for token authentication, current owner permission, source-local question retrieval and owner-controlled deletion/readback. The adapter stores no course, graph, question or answer history. Its context callback can query a local knowledge graph, lexical index or content reader. Permission is checked again after retrieval so revocation during a read prevents its result from leaving the service.

An LMS/publisher must install and configure this adapter, map its verified launch subjects to the connected agent identity, and implement its content/owner-policy callbacks before its real courses can use this mode. The Ask connector and adapter do not imply that every LMS already exposes these services. Existing SCORM Cloud API integration remains available independently of how learners launch its course through LTI.

## Verification scope

Focused tests cover actual cache reuse, permission expiry/revocation, cross-session isolation, deletion during an in-flight read, content identity/refresh, source-provider protocol binding, DNS/redirect/response bounds, owner policy and source-side deletion receipts. Local source-service round trips prove the implemented protocol; they do not certify an arbitrary publisher or an installed external LMS integration. The earlier live SCORM Cloud Q&A test remains separate evidence for that provider's export path.
