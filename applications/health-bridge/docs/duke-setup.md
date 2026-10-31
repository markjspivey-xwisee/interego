# Duke MyChart app registration

The connector is implemented, but actual Duke authorization is unavailable until a production Epic application is registered and enabled. Reading public metadata does not grant patient access.

## Deployed app fields

* Application name: **Interego Health Connections**
* App audience: patient-facing, including authorized proxy selection where Duke permits it
* FHIR version: **R4**
* Access: **read-only**
* Launch: standalone SMART authorization-code flow
* Confidential client, persistent access, S256 PKCE
* Application origin: `https://health-bridge-production-dc71.up.railway.app`
* Redirect URI: `https://health-bridge-production-dc71.up.railway.app/oauth/duke/callback`
* Public JWKS URI: `https://health-bridge-production-dc71.up.railway.app/.well-known/jwks.json`
* Client authentication: **private_key_jwt**, configured for Duke; no private key is uploaded in chat or checked into source control

The operator must register the application through Epic's developer portal, review and accept the relevant developer/production terms, select qualifying USCDI read APIs, enable automatic client distribution where eligible, and make it ready for production. Epic's current guidance describes customer download intervals of up to twelve hours. The app's actual availability at Duke must be checked afterward.

Set the actual **production** client identifier as `DUKE_CLIENT_ID` in the bridge service's secret configuration. The server's persistent signing key and key ID have already been configured in the deployment; the public key document is used for registration. Never substitute a sandbox identifier or a fabricated client ID.

## Verified provider discovery

* FHIR base: `https://health-apis.duke.edu/FHIR/api/FHIR/R4`
* SMART configuration: `https://health-apis.duke.edu/FHIR/api/FHIR/R4/.well-known/smart-configuration`
* Authorization endpoint discovered on October 31, 2026: `https://health-apis.duke.edu/FHIR/oauth2/authorize`
* Token endpoint discovered on that date: `https://health-apis.duke.edu/FHIR/oauth2/token`
* Epic directory organization: Duke University Health System, **733**

Discovery is repeated with the real `Epic-Client-ID` because provider endpoints can vary by registered client. Only returned, pinned Duke endpoints are used.

Requested scope: `launch/patient offline_access openid fhirUser patient/Patient.read patient/Condition.read patient/Observation.read patient/MedicationRequest.read patient/AllergyIntolerance.read patient/Procedure.read patient/DiagnosticReport.read patient/DocumentReference.read patient/Binary.read`.

The patient or authorized proxy then signs into the bridge through Interego, enables private imports, chooses **Connect MyChart**, signs into Duke, selects the intended chart and approves the permissions. The bridge records the patient context returned by Duke's token exchange and refuses an unexpected change on refresh.

## Coverage and limits

`MedicationRequest` means an order, not a dose administration. Duke advertises `MedicationAdministration`, but that API is an optional extended capability and is not silently requested through the reviewed USCDI registration path. `MedicationStatement` is not declared by the reviewed Duke R4 metadata.

Clinical-document bodies are read only when referenced by a patient-bound `DocumentReference`, within the Duke FHIR Binary service, with the granted Binary scope and provider capability. Other attachments remain explicitly unavailable. Structured reads and note-body coverage are reported separately. A denied endpoint, truncated page, missing attachment or incomplete import does not advance the sync watermark.

No patient data is retrieved until real registration and Duke authorization succeed. No source data is automatically released to the public Atlas.

Official references:

* [Epic developer resources](https://open.epic.com/DeveloperResources)
* [Epic patient-facing FHIR app documentation](https://fhir.epic.com/Documentation?docId=patientfacingfhirapps&section=AutomaticClientDistribution)
* [Epic MyChart app-sharing guidance](https://www.mychart.org/l/en-us/help/share-health-data-app/)
* [Duke's medical-record access guide](https://www.dukehealth.org/medical-records)
