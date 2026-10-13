# W3C contexts for the tests

Static copies of two JSON-LD contexts the Verifiable Credentials Data Model 2.0 defines, so tests can
expand Foxxi records the way a verifier does without fetching anything. VC 2.0 asks implementations
to use exactly this: a static copy of the base context, or its cryptographic digest.

| File | Source | SHA-256 |
|---|---|---|
| `credentials-v2.jsonld` | <https://www.w3.org/ns/credentials/v2> | `59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734` |
| `credentials-undefined-terms-v2.jsonld` | <https://www.w3.org/ns/credentials/undefined-terms/v2> | `82dab514ba44eb18f5d1b0f638c5e140c6a556fbfb5089601bdc0fa5eb8b2581` |

Retrieved 2026-10-12. The base context's digest is the one the Recommendation publishes
(<https://www.w3.org/TR/vc-data-model-2.0/>, "SHA2-256 digest value of the base context file"); the
tests check both files against these digests before using them.

Copyright © World Wide Web Consortium. These files are W3C documents, used and redistributed
unmodified under the W3C Software and Document License
(<https://www.w3.org/copyright/software-license-2023/>). They are not part of this project's MIT-licensed code.
