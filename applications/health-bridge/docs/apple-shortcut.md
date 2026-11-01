# Apple Health → private Interego import

This bridge accepts selected Health samples. It does not yet install an iPhone shortcut, grant Health permission, read an Apple cloud account, or guarantee background delivery. A successful server test is not evidence of a live iPhone connection.

## What is supported

`normalizeAppleBatch` validates a bounded JSON upload of `steps`, `heartRate`, `restingHeartRate`, `activeEnergy`, `bodyMass`, `oxygenSaturation`, and `sleep`. It preserves each sample's source and original value/unit/timestamps. It does not calculate cross-device totals, infer diagnoses, establish complete history, or publish the import.

The paired device credential must be upload-only and bound by the server to the intended private record. The server must derive the patient/record from that credential; a phone upload must not choose a different patient. Keep the broad Interego credential on the private server. Do not put credentials in a URL.

The JSON path is implemented. An Apple Health XML/ZIP parser and a signed `.shortcut` artifact are **not** implemented by this module.

## Set up and test a manual shortcut first

1. On Mayya's iPhone, open the private bridge's authenticated setup page and follow its device-pairing process. Use the actual HTTPS upload endpoint and revocable upload-only token it supplies. This document does not invent a live endpoint.
2. In Apple Shortcuts, create a shortcut named **Sync Health to Interego**.
3. Add **Find Health Samples**. Choose one metric and a short interval, initially a low-volume metric such as Weight. Select the desired start/end date filters and order. The mapping between the displayed picker label (for example Weight) and the bridge name (`bodyMass`) is explicit below.
4. Inspect the Health Sample variable's available properties on the actual phone. For each result, use its value, unit, start/end dates, and source if those properties are exposed by that iOS version. Exact detail-action labels and formatting must be confirmed on-device. Do not invent unavailable UUIDs. If `id` is omitted, the bridge generates a content hash and labels it as derived, not a native HealthKit UUID.
5. Use Shortcuts **Dictionary**, **List**, and **Repeat with Each** actions to construct the JSON envelope below. Use numeric variables for quantities rather than values concatenated into a text JSON template. Format dates with an explicit timezone, such as `2026-10-30T12:00:00-04:00`; include seconds. Inspect the actual ISO date output before relying on it.
6. Add **Get Contents of URL** using the endpoint supplied by device setup. Choose **POST** with a **JSON** request body. Set request headers to `Authorization: Bearer <upload-only-token>` and `Content-Type: application/json`. Do not use query-string tokens. The token may be visible to someone who can inspect the shortcut; its scope, revocation and expiry must therefore be enforced by the server.
7. Run manually while the phone is unlocked. Grant only the desired Health read permissions and requested network permission. No Health write permission is needed.
8. Check the bridge's acknowledgement and compare at least one imported sample's value, unit, actual observation date and source against Apple Health. Check the private record destination too. A network response alone does not prove the right patient's data was imported.
9. Repeat a successful upload and verify idempotent storage. The backend must detect conflicting reuse of a client-supplied batch ID. The normalizer only validates individual batches; it is not the durable idempotency store.

Example request (illustrative data only):

```json
{
  "version": 1,
  "deviceId": "paired-phone-1",
  "client": "shortcuts",
  "windowStart": "2026-10-30T00:00:00-04:00",
  "windowEnd": "2026-10-31T00:00:00-04:00",
  "coverage": {
    "mode": "selected-samples",
    "metrics": ["bodyMass"],
    "complete": false
  },
  "samples": [
    {
      "metric": "bodyMass",
      "value": 150,
      "unit": "lb",
      "startDate": "2026-10-30T12:00:00-04:00",
      "endDate": "2026-10-30T12:00:00-04:00",
      "source": "Health"
    }
  ]
}
```

`batchId` may be supplied as a short device-generated identifier; when omitted, the bridge derives one from the batch's normalized contents. `schemaVersion: "interego.apple-health.samples.v1"` is an alternative to `version: 1`. No more than 1,000 samples or one MiB of JSON can be normalized in one request. A larger history must be split into acknowledged bounded windows, with no assumed completeness.

## Explicit metric and unit mapping

| Phone-selected data type | Bridge `metric` | Accepted `unit` | Stored canonical unit |
| --- | --- | --- | --- |
| Steps | `steps` | `count`, `steps` | `count` |
| Heart rate | `heartRate` | `count/min`, `bpm` | `count/min` |
| Resting heart rate | `restingHeartRate` | `count/min`, `bpm` | `count/min` |
| Active energy | `activeEnergy` | `kcal`, `kJ`, `J` | `kcal` |
| Weight / body mass | `bodyMass` | `kg`, `g`, `lb` | `kg` |
| Blood oxygen / oxygen saturation | `oxygenSaturation` | `%`, `1`, `fraction` | `%` |
| Sleep category interval | `sleep` | `category` | `category` |

Sleep values are the explicit strings `inBed`, `awake`, `asleep`, `asleepUnspecified`, `core`, `deep`, or `rem`. The shortcut must map its observed category labels deliberately. The bridge does not accept a guessed number of hours as a category or add overlapping sleep stages into a total.

Oxygen saturation `0.96` with unit `1` or `fraction` becomes `96` `%`; `96` with unit `1` is rejected. Never guess an omitted unit. Phone picker labels and units can vary by locale/version: inspect them instead of silently removing a suffix from text.

Raw Apple Watch and iPhone samples may overlap. Do not add them together as a daily total. This protocol retains source metadata and does no aggregation. A native companion can separately obtain HealthKit statistics, with their aggregation semantics recorded, if totals are needed later.

## Automations are a separate, device-tested step

Apple supports automatic personal-automation triggers including Time of Day. After the manual flow passes, choose a trigger likely to occur while the phone is unlocked. The exact iOS automation controls vary by version; use the installed device's options for running without asking. Individual actions may still require permission.

Health data is normally protected while the phone is locked. Enabling a shortcut to run while locked does not remove HealthKit's data protection. A failed or empty read must not clear the private record or advance a completeness watermark. Retry on the next unlocked/manual run and show the last successful receipt in the private setup/status screen. A day with no delivered samples is not a diagnosis, evidence of no activity, or evidence that permission was denied.

Overlapping lookback windows help recover late-arriving measurements. Content-derived IDs support exact retry deduplication but cannot establish true HealthKit object identity, detect corrected originals reliably, or supply deletion tombstones. Do not interpret an empty Shortcuts query as a deletion signal.

## Native HealthKit extension

A native iPhone companion is the stronger incremental-sync path. It can request per-type read-only permission, keep its upload token in Keychain, use observer notifications and anchored queries, persist an anchor only after acknowledgement, and retry protected-store reads after unlock. Background delivery timing is not a service-level guarantee.

Native clients may set `client: "healthkit-native"` and supply `deletions: [{"id":"<HealthKit UUID>","metric":"bodyMass"}]`. The bridge labels these IDs as **client-asserted**, not cryptographically authenticated HealthKit provenance. It rejects Shortcuts tombstones, derived-ID tombstones, and a batch that both adds and deletes the same sample. The authenticated server remains responsible for restricting a paired credential to the expected client capabilities.

Clinical Health Records require an additional capability and separate authorization, including the user's choice of current-only versus current-and-future records. This selected-metric JSON protocol does not yet import clinical FHIR records, clinical-note attachments, or a complete MyChart chart. Avoid importing a single provider test twice through both a future MyChart feed and Apple Health clinical records.

## Official Apple references

- [Find and Filter actions](https://support.apple.com/guide/shortcuts/apd3c845e881/ios)
- [Get Contents of URL and JSON request bodies](https://support.apple.com/guide/shortcuts/apd58d46713f/ios)
- [Shortcuts API limitations](https://support.apple.com/guide/shortcuts/apd891a6c84e/ios)
- [Personal automation controls](https://support.apple.com/guide/shortcuts/apd602971e63/ios)
- [HealthKit privacy and locked-device behavior](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)
- [HealthKit query types](https://developer.apple.com/documentation/healthkit/reading-data-from-healthkit)
- [Sharing and exporting Health data](https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/ios)
