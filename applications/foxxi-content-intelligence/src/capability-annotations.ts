/**
 * Operation scope and prerequisites for the live capability directory.
 *
 * Implementation means a handler exists, never that this request was executed.
 * Per-invocation readiness and verification belong to the actual runner response.
 * Generic handler instrumentation can record an operation observation separately.
 * The four owner-bound handlers must land with this catalogue revision.
 */
export interface CapabilityAnnotation {
  implementation: 'implemented' | 'not-implemented';
  mode: 'read' | 'write' | 'document-builder' | 'computation' | 'client-required';
  authorization: 'public' | 'signed' | 'role-gated' | 'owner';
  requires: string[];
  notes: string[];
  example?: { arguments: Record<string, unknown>; label: string };
  signing?: {
    schema: Record<string, unknown>;
    payload: Record<string, unknown>;
    instructions: readonly string[];
  };
}

export const FOXXI_CAPABILITY_ANNOTATIONS: Record<string, CapabilityAnnotation> = {
  "foxxi.i2idlx_capabilities": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [
      "bridge process"
    ],
    "notes": [
      "shared:true means configured, not successful end-to-end authenticated persistence",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; safe live invocation returned HTTP200."
    ],
    "example": {
      "arguments": {},
      "label": "Read public contract"
    }
  },
  "foxxi.i2idlx_challenge": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [
      "bridge process",
      "pending challenge capacity <4096"
    ],
    "notes": [
      "Not invoked because audit excluded stateful actions",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ],
    "example": {
      "arguments": {},
      "label": "Read public contract"
    }
  },
  "foxxi.i2idlx_session": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "owner",
    "requires": [
      "existing own pod HEAD",
      "cryptographically verified VC",
      "independently pinned owner signing address",
      "stable bridge key/admission for shared standing"
    ],
    "notes": [
      "owner_encryption_key is optional but absent key yields sharedWrite:false and privateEncryption:false",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.i2idlx_read": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "owner",
    "requires": [
      "existing pod",
      "stable bridge encryption key",
      "signed participant admission for shared",
      "valid unchanged author VC/owner pin"
    ],
    "notes": [
      "Unreadable, unauthorized or forged state is an error, not empty verified data",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.i2idlx_write": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "author-owned durable X25519 public key bound in signature",
      "stable bridge encryption key",
      "strong preceding ETag or absent create",
      "existing own/shared pod write transport"
    ],
    "notes": [
      "Do not enable generic Try for writes; prepare exact reviewed document and sign only after authorization",
      "Claim durable only from ok:true/durable:true exact readback; no successful write attempted in audit",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.i2idlx_ask": {
    "implementation": "implemented",
    "mode": "client-required",
    "authorization": "public",
    "requires": [
      "valid generated public app-data.json",
      "shared ask-rules.js module",
      "connected client model for actual answer"
    ],
    "notes": [
      "HTTP200 packet is not an answered question; connected client must execute instructions",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; safe live invocation returned HTTP200."
    ],
    "example": {
      "arguments": {
        "question": "What is a learning record store?"
      },
      "label": "Prepare a real glossary Ask task"
    }
  },
  "foxxi.i2idlx_orchestrate": {
    "implementation": "implemented",
    "mode": "client-required",
    "authorization": "public",
    "requires": [
      "valid generated public app-data.json",
      "scenario.js module",
      "connected client model/tools and human authority for actual external writes"
    ],
    "notes": [
      "Returned workflow source contains browser sandbox method names, not callable MCP tools",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; safe live invocation returned HTTP200."
    ],
    "example": {
      "arguments": {
        "brief": "Review the public I2IDL-X capability directory and distinguish discovered contracts from demonstrated live behavior.",
        "records": [
          {
            "id": "i2idlx-capabilities",
            "title": "I2IDL-X workbench capability contract",
            "description": "The public workbench capabilities endpoint advertises Ask and Orchestrate as instructions-only tasks for the connected client, with no project-paid sampling.",
            "sourceTypes": [
              "capability contract"
            ]
          }
        ]
      },
      "label": "Prepare a capability audit workflow"
    }
  },
  "llm_telemetry.profile": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [
      "in-process telemetryProfile()"
    ],
    "notes": [
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; safe live invocation returned HTTP200."
    ],
    "example": {
      "arguments": {},
      "label": "Read public contract"
    }
  },
  "llm_telemetry.ingest": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "own-lens LRS",
      "encrypted own-pod PGSL",
      "capture revision for server observations",
      "independent client/server opt-in"
    ],
    "notes": [
      "Not invoked: writes real telemetry",
      "502 can mean partial commit; identical source_event_id/metadata retry only; conflicting reuse409",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "llm_telemetry.query": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "owner",
    "requires": [
      "own-lens LRS and own PGSL snapshot; unavailable sources exposed",
      "valid query schema"
    ],
    "notes": [
      "Not invoked: audit excluded credential creation, including transient internal credential",
      "Does not infer measured usage where missing; conflicting IDs/source gaps explicit",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "llm_telemetry.capture_read": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "owner",
    "requires": [
      "own encrypted PGSL preferences readable"
    ],
    "notes": [
      "Default server_enabled/client_enabled false only after readable absent history; unavailable history503",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "llm_telemetry.capture_update": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "own encrypted PGSL writable/readable",
      "expected revision if supplied"
    ],
    "notes": [
      "Not invoked: explicit consent mutation",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "llm_telemetry.client_setup": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [
      "supported runtime and exact existing server_name for usable config",
      "separate host trust/install and client consent for real delivery"
    ],
    "notes": [
      "200 overview has host_activation:not-verified; not proof of collector delivery or host setup",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; safe live invocation returned HTTP200."
    ],
    "example": {
      "arguments": {
        "client": "overview"
      },
      "label": "Read public contract"
    }
  },
  "llm_telemetry.collector_create": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "client_enabled true",
      "readable/writable encrypted own collector registry",
      "exact account_id for Cowork exports",
      "live or validation capture mode"
    ],
    "notes": [
      "Not invoked: creates credential",
      "Token/private native settings must never be copied into public audit artifacts; host activation remains unverified",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "llm_telemetry.collector_revoke": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "known own collector_id",
      "readable/writable own collector registry"
    ],
    "notes": [
      "Not invoked: revokes credential; observations preserved",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.record_private_performance_outcome": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "Fresh own-account signature",
      "Existing server plan plus bound measured report evidence",
      "Reachable encrypted private pod storage"
    ],
    "notes": [
      "Records one supplied measured episode; causal learning and independent sampling are explicitly not established."
    ]
  },
  "foxxi.read_private_performance_outcomes": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "owner",
    "requires": [
      "Fresh own-account signature and reachable encrypted private pod storage"
    ],
    "notes": [
      "Reads actual own-account private records. Private calibration excludes seeds and does not establish causal effects."
    ]
  },
  "foxxi.read_private_performance_calibration": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "owner",
    "requires": [
      "Fresh own-account signature and reachable encrypted private pod storage"
    ],
    "notes": [
      "Reads actual own-account private records. Private calibration excludes seeds and does not establish causal effects."
    ]
  },
  "foxxi.discover_lrs": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [
      "The bridge LRS about resource"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "The current backend explicitly reports in-memory single-replica storage lost on restart, statementForwarding:false. Discovery is not a durability or authenticated read/write check."
    ],
    "example": {
      "label": "Read current LRS versions and backend limits",
      "arguments": {}
    }
  },
  "foxxi.discover_assigned_courses": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.discover_course_catalogs": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.earned_credentials": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.claim_credential": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Configured tenant issuer key and genuine action-specific evidence"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.verify_credential": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.earned_credentials_signed": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.claim_credential_signed": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.cmi5_launch_signed": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.lti_launch_signed": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.lti_gradebook_signed": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.consume_lesson": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "Fresh own-account signed request",
      "Existing reachable source lesson",
      "For record-progress: signature-bound owner key and unique actual advanced slide ids"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Requires the new owner-bound implementation in this release; the audited baseline returned 501. No successful live execution is claimed here.",
      "Load mode returns real source lesson content. Progress mode stores Hypothetical authenticated self-report, never completion/mastery proof."
    ],
    "signing": {
      "schema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "const": "foxxi.consume_lesson"
          },
          "tenant_pod_url": {
            "type": "string",
            "description": "Optional corroboration of the authenticated own pod; cannot select another pod."
          },
          "course_iri": {
            "type": "string",
            "description": "Exact published CoursePackageBundle federation_iri_base plus #package."
          },
          "learner_did": {
            "type": "string",
            "description": "Optional; must equal verified caller."
          },
          "mode": {
            "type": "string",
            "enum": [
              "load",
              "record-progress"
            ],
            "default": "load"
          },
          "advanced_slide_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "uniqueItems": true,
            "minItems": 1,
            "maxItems": 10000
          },
          "owner_encryption_key": {
            "type": "string",
            "description": "Signature-bound canonical base64 X25519 public key held by the owner; never an unsigned discovered key."
          },
          "bridge_audience": {
            "type": "string",
            "description": "Exact current bridge origin, without a trailing slash; derive it from this manifest authority, never a caller-selected different service."
          }
        },
        "required": [
          "action",
          "bridge_audience",
          "course_iri"
        ],
        "allOf": [
          {
            "if": {
              "properties": {
                "mode": {
                  "const": "record-progress"
                }
              },
              "required": [
                "mode"
              ]
            },
            "then": {
              "required": [
                "advanced_slide_ids",
                "owner_encryption_key"
              ]
            }
          }
        ]
      },
      "payload": {
        "action": "foxxi.consume_lesson",
        "bridge_audience": "https://foxxi-bridge.interego.xwisee.com",
        "course_iri": "",
        "mode": "load"
      },
      "instructions": [
        "This is a preparation template, not a signed or executed request.",
        "Fill every blank from your actual own-pod course, operator-configured connector or observed audit action. Do not invent completion, assessment or achievement records.",
        "Use the exact bridge_audience supplied by this directory. Do not change it to another service.",
        "For a write, supply only your established owner-held X25519 PUBLIC key. Never paste its private key, a signing seed, model key, password or LMS credential.",
        "Pass the completed inner payload to Interego sign_request using your authenticated account. It supplies the bound identity and timestamp.",
        "Submit only the actual returned _signed_payload and _signature to this operation. Unsigned outer fields and browser _session grant envelopes are not accepted.",
        "A preparation template is not proof of authorization, a successful write or a verified durable result."
      ]
    }
  },
  "foxxi.ask_course_question": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [
      "Inline FoxxiCourseContent with actual transcripts/concepts"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Lexical retrieval with source snippets, not an AI model call. Caller-supplied content is not independently fetched or attributed."
    ]
  },
  "foxxi.ask_course_question_agentic": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "May run a paid model using a per-request key or configured operator key; no automatic directory example should call this path.",
      "Requires a real authorized course payload; lack of a model connection must not be displayed as a model answer."
    ]
  },
  "foxxi.retrieve_course_context": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.explore_concept_map": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.extend_standards": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "Supported extension kind, name and definition"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Returns a proposed extension artifact and publishable descriptor; no standard is officially amended and nothing is automatically published."
    ]
  },
  "foxxi.review_record": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.issue_credential": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.verify_extension": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.prove_competency_signed": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.self_assert_competency": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.verify_presentation": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.void_credential": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.publish_encryption_key": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.course_analyze": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "public",
    "requires": [
      "Actual SCORM manifest/package inputs and writable shared lattice for persistence"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "This operation composes a course holon and can write. It is not a harmless preview."
    ]
  },
  "foxxi.course_analyze_authored": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "public",
    "requires": [
      "An existing authored course id and reachable author source"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "May compose a course-KG holon while analyzing existing content. No automatic directory preview should assume it is read-only."
    ]
  },
  "foxxi.course_ask": {
    "implementation": "implemented",
    "mode": "client-required",
    "authorization": "public",
    "requires": [
      "A real FoxxiAgenticCourse object"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "Without llm_api_key returns a retrieval scaffold for the client to synthesize. Supplying a BYOK key triggers paid model synthesis. No default example should include an API key."
    ]
  },
  "foxxi.course_skill": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "A real FoxxiAgenticCourse object with concepts and slides"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "Returns SKILL.md only. Does not publish content or record achievement."
    ]
  },
  "foxxi.course_analyze_skill": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "public",
    "requires": [
      "Actual SKILL.md content and writable shared lattice for persistence"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "Parsing can compose a course-KG holon. Translation-only use is foxxi.skill_affordance."
    ]
  },
  "foxxi.skill_affordance": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "The SKILL.md text to translate"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "Returns descriptor Turtle and a round-trip Markdown projection only. Does not publish, sign or verify the supplied author identity."
    ]
  },
  "foxxi.course_propose_successor": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "public",
    "requires": [
      "Actual course and source performance signals; writable shared lattice"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "Creates a successor holon. The operation is not a model agent reasoning by itself and does not prove measured performance improvement."
    ]
  },
  "foxxi.calibration_merge": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "Genuine signed contributor aggregates, distinct contributor keys and the configured suppression floor",
      "Writable shared lattice"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim.",
      "Pools supplied signed observations. Contributor authenticity and aggregation thresholds do not establish independent sampling or causal efficacy."
    ]
  },
  "foxxi.record_performance_signed": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.ingest_course": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.record_course_completion": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.forwarding_targets": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.write_xapi_statements_signed": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.read_xapi_statements_signed": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.credentials": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.publish_memory": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_fragment": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_compose": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_fold_course": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_resolve": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_admit": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_admissions": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_mine": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_launch": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.content_next": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.xapi_author": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "This contract is an HTTP action. Follow its advertised descriptor and action; it is not automatically a named bridge MCP shim."
    ]
  },
  "foxxi.scorm_author": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "signed caller",
      "own pod writable",
      "SCORM manifest parser",
      "PGSL lattice persistence"
    ],
    "notes": [
      "Not invoked: creates genuine course/activity/pod state",
      "Success requires the actual awaited sharedLattice.persisted receipt. Missing or failed persistence returns 503 with any available receipt and a warning to inspect the pod before retrying; parsed content alone is not a saved course.",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.scorm_launch": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "existing authored course in cache or authoritative owner pod/lattice",
      "course-author registry",
      "runtime sequencing engine"
    ],
    "notes": [
      "Not invoked: begins real learner attempt",
      "Attempt lives in process memory and is not evidence of durable learning outcome",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.scorm_submit": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "live owned session",
      "valid assessment response",
      "actual LRS write confirmation"
    ],
    "notes": [
      "Not invoked: would record learner experience",
      "503 preserves ended outcome/session for retry when LRS did not hold it; no learning achievement claimed",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.scorm_course_ask": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [
      "existing course",
      "optional cached remote I2IDL glossary; course-only fallback when unavailable"
    ],
    "notes": [
      "Not invoked because no known selected authored course supplied; do not fabricate a course id",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract.",
      "Choose an existing verified course before offering Try; no placeholder course id is an executable example."
    ]
  },
  "foxxi.scorm_dispatch": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "known course",
      "owner registry",
      "tenant pod dispatches.json",
      "actual LMS SCORM API to play stub"
    ],
    "notes": [
      "Not invoked: external publication/control state",
      "201 confirms process registry entry; durable registry save is debounced and retried, not awaited before response",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.scorm_dispatch_revoke": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "known owned dispatch",
      "tenant pod registry for restart survival"
    ],
    "notes": [
      "Not invoked: changes live distributed launch control",
      "Withdrawal response does not prove durable pod write; retry scheduling backoff up to five minutes",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.scorm_dispatches": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "owner",
    "requires": [
      "valid caller",
      "in-process registry/hydrated durable copy"
    ],
    "notes": [
      "Not invoked: authenticated read not covered by this audit",
      "List route reads current in-memory ownedBy without forcing fresh reload",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; this audit did not execute the authenticated/stateful contract."
    ]
  },
  "foxxi.bind_decoration": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "in-process decoration templates"
    ],
    "notes": [
      "Bound control generation does not verify target-system availability, credentials, behavior or standards conformance",
      "Source and test inspection at 74475d4a0220abc6f7d3e8134258d0908d1607a9; safe live invocation returned HTTP200."
    ],
    "example": {
      "arguments": {
        "decoration": "lrs-x",
        "values": {
          "endpoint": "https://foxxi-bridge.interego.xwisee.com/xapi"
        }
      },
      "label": "Bind LRS-X to the public Foxxi LRS"
    }
  },
  "foxxi.read_intervention_methods": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [],
    "notes": [
      "Returns versioned methodology profiles, not an intervention effect or certification."
    ],
    "example": {
      "label": "Read the actual method catalogue",
      "arguments": {}
    }
  },
  "foxxi.review_method_evidence": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [],
    "notes": [
      "Checks supplied evidence-pointer coverage only. It does not fetch artifact contents or verify quality, authorship, efficacy or causation."
    ],
    "example": {
      "label": "Inspect consulting's missing evidence criteria",
      "arguments": {
        "method": "consulting",
        "evidence": []
      }
    }
  },
  "foxxi.ingest_content_package": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "A complete sign_request envelope verified as the target pod owner"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.publish_authoring_policy": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "A complete sign_request envelope verified as the target pod owner"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.connect_lms": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "Fresh target-owner signed request with owner-held encryption key",
      "Exact operator-configured connector identity, HTTPS endpoint and server-side credentials, bound by operator configuration to the authenticated own pod",
      "Successful bounded identity probe and encrypted pod write/readback"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Requires the new owner-bound implementation in this release; the audited baseline returned 501. No successful live execution is claimed here.",
      "Registers verified connection metadata only. No background synchronization schedule is activated."
    ],
    "signing": {
      "schema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "const": "foxxi.connect_lms"
          },
          "tenant_pod_url": {
            "type": "string",
            "description": "Optional corroboration of the authenticated own pod; cannot select another pod."
          },
          "connector_id": {
            "type": "string"
          },
          "product": {
            "type": "string"
          },
          "instance": {
            "type": "string",
            "description": "Exact operator-configured HTTPS instance."
          },
          "auth_method": {
            "type": "string"
          },
          "sync_frequency": {
            "type": "string",
            "enum": [
              "manual"
            ],
            "default": "manual"
          },
          "owner_encryption_key": {
            "type": "string",
            "description": "Signature-bound canonical base64 X25519 public key held by the owner; never an unsigned discovered key."
          },
          "bridge_audience": {
            "type": "string",
            "description": "Exact current bridge origin, without a trailing slash; derive it from this manifest authority, never a caller-selected different service."
          }
        },
        "required": [
          "action",
          "bridge_audience",
          "connector_id",
          "product",
          "instance",
          "auth_method",
          "owner_encryption_key"
        ]
      },
      "payload": {
        "action": "foxxi.connect_lms",
        "bridge_audience": "https://foxxi-bridge.interego.xwisee.com",
        "connector_id": "",
        "product": "",
        "instance": "",
        "auth_method": "",
        "sync_frequency": "manual",
        "owner_encryption_key": ""
      },
      "instructions": [
        "This is a preparation template, not a signed or executed request.",
        "Fill every blank from your actual own-pod course, operator-configured connector or observed audit action. Do not invent completion, assessment or achievement records.",
        "Use the exact bridge_audience supplied by this directory. Do not change it to another service.",
        "For a write, supply only your established owner-held X25519 PUBLIC key. Never paste its private key, a signing seed, model key, password or LMS credential.",
        "Pass the completed inner payload to Interego sign_request using your authenticated account. It supplies the bound identity and timestamp.",
        "Submit only the actual returned _signed_payload and _signature to this operation. Unsigned outer fields and browser _session grant envelopes are not accepted.",
        "A preparation template is not proof of authorization, a successful write or a verified durable result."
      ]
    }
  },
  "foxxi.assign_audience": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "A complete sign_request envelope verified as the target pod owner"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.coverage_query": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [
      "Explicit supplied coverage records; additional privacy-mode parameters for a histogram"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Aggregates only request.coverage. Does not discover catalog coverage or apply the removed category/concept filters. Supplied records are not independently verified. Bounds: 1000 unique concept records, 1000 references per list, 10000 total references and 2048 characters per string."
    ]
  },
  "foxxi.publish_concept_map": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "Fresh target-owner signature and encryption key",
      "Actual published source course/concepts",
      "For sharing: signature-bound recipient DIDs and public encryption keys"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Requires the new owner-bound implementation in this release; the audited baseline returned 501. No successful live execution is claimed here.",
      "Publishes a projection of the existing course, encrypted by default. Sharing requires explicit bound recipients; no fabricated source concepts."
    ],
    "signing": {
      "schema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "const": "foxxi.publish_concept_map"
          },
          "tenant_pod_url": {
            "type": "string",
            "description": "Optional corroboration of the authenticated own pod; cannot select another pod."
          },
          "course_iri": {
            "type": "string"
          },
          "owner_encryption_key": {
            "type": "string",
            "description": "Signature-bound canonical base64 X25519 public key held by the owner; never an unsigned discovered key."
          },
          "federation_share_with": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Explicit recipient DIDs; each requires its bound public key."
          },
          "recipient_encryption_keys": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            },
            "description": "DID to canonical base64 X25519 public key; all entries are signature covered."
          },
          "bridge_audience": {
            "type": "string",
            "description": "Exact current bridge origin, without a trailing slash; derive it from this manifest authority, never a caller-selected different service."
          }
        },
        "required": [
          "action",
          "bridge_audience",
          "course_iri",
          "owner_encryption_key"
        ]
      },
      "payload": {
        "action": "foxxi.publish_concept_map",
        "bridge_audience": "https://foxxi-bridge.interego.xwisee.com",
        "course_iri": "",
        "owner_encryption_key": "",
        "federation_share_with": [],
        "recipient_encryption_keys": {}
      },
      "instructions": [
        "This is a preparation template, not a signed or executed request.",
        "Fill every blank from your actual own-pod course, operator-configured connector or observed audit action. Do not invent completion, assessment or achievement records.",
        "Use the exact bridge_audience supplied by this directory. Do not change it to another service.",
        "For a write, supply only your established owner-held X25519 PUBLIC key. Never paste its private key, a signing seed, model key, password or LMS credential.",
        "Pass the completed inner payload to Interego sign_request using your authenticated account. It supplies the bound identity and timestamp.",
        "Submit only the actual returned _signed_payload and _signature to this operation. Unsigned outer fields and browser _session grant envelopes are not accepted.",
        "A preparation template is not proof of authorization, a successful write or a verified durable result."
      ]
    }
  },
  "foxxi.publish_compliance_evidence": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "Fresh target-owner signature and encryption key",
      "Allowed event type, framework and controls with actual caller report"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Requires the new owner-bound implementation in this release; the audited baseline returned 501. No successful live execution is claimed here.",
      "Persists Hypothetical caller-reported evidence. Does not establish independent completion or satisfaction of a regulatory control."
    ],
    "signing": {
      "schema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "const": "foxxi.publish_compliance_evidence"
          },
          "tenant_pod_url": {
            "type": "string",
            "description": "Optional corroboration of the authenticated own pod; cannot select another pod."
          },
          "event_type": {
            "type": "string",
            "enum": [
              "assignment-created",
              "completion",
              "exception",
              "audit-action"
            ]
          },
          "event_payload": {
            "type": "object",
            "description": "assignment-created:{user_id,course_iri,due_at}; completion:{user_id,course_iri,completed_at}; exception:{reason}; audit-action:{action}. Dates are ISO timestamps."
          },
          "framework": {
            "type": "string",
            "enum": [
              "soc2",
              "eu-ai-act",
              "nist-rmf"
            ],
            "default": "soc2"
          },
          "controls": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 100,
            "description": "IRIs in the selected published framework control set."
          },
          "owner_encryption_key": {
            "type": "string",
            "description": "Signature-bound canonical base64 X25519 public key held by the owner; never an unsigned discovered key."
          },
          "bridge_audience": {
            "type": "string",
            "description": "Exact current bridge origin, without a trailing slash; derive it from this manifest authority, never a caller-selected different service."
          }
        },
        "required": [
          "action",
          "bridge_audience",
          "event_type",
          "event_payload",
          "owner_encryption_key"
        ]
      },
      "payload": {
        "action": "foxxi.publish_compliance_evidence",
        "bridge_audience": "https://foxxi-bridge.interego.xwisee.com",
        "event_type": "audit-action",
        "event_payload": {
          "action": ""
        },
        "framework": "soc2",
        "controls": [],
        "owner_encryption_key": ""
      },
      "instructions": [
        "This is a preparation template, not a signed or executed request.",
        "Fill every blank from your actual own-pod course, operator-configured connector or observed audit action. Do not invent completion, assessment or achievement records.",
        "Use the exact bridge_audience supplied by this directory. Do not change it to another service.",
        "For a write, supply only your established owner-held X25519 PUBLIC key. Never paste its private key, a signing seed, model key, password or LMS credential.",
        "Pass the completed inner payload to Interego sign_request using your authenticated account. It supplies the bound identity and timestamp.",
        "Submit only the actual returned _signed_payload and _signature to this operation. Unsigned outer fields and browser _session grant envelopes are not accepted.",
        "A preparation template is not proof of authorization, a successful write or a verified durable result."
      ]
    }
  },
  "foxxi.issue_completion_credential": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Configured tenant issuer key and genuine action-specific evidence"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.export_clr": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.assemble_learner_record": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.record_performance": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.record_agent_trajectory": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.get_agent_trajectory": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.assess_agent_disposition": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.run_performance_probe": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.open_agent_evaluation": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.request_evaluation_enrollment": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.decide_evaluation_candidate": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.record_external_agent_run": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.get_agent_evaluation": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.compare_agent_evaluation": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.export_case_framework": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Builds a CASE document from the tenant catalogue audience-tag taxonomy, not an independently assessed competency ontology."
    ]
  },
  "foxxi.emit_cmi5_session": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Builds statement documents from supplied session values only. Does not launch, forward or persist the claimed session; returned documents are not measured achievement evidence."
    ]
  },
  "foxxi.resolve_did": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Resolves public identity documents or computes supported DID representations; resolution alone proves neither delegation nor private-key custody."
    ],
    "example": {
      "label": "Resolve this ChatGPT agent's public DID document",
      "arguments": {
        "did": "did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-731e988c2c5b"
      }
    }
  },
  "foxxi.query_experience_index": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Tenant admin role",
      "Explicit existing LRS endpoints and credentials"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Queries external LRS endpoints. Credentials and returned private statement data must not be fabricated or placed in a default public example."
    ]
  },
  "foxxi.push_to_cass": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Tenant admin role",
      "Configured or supplied authorized CaSS endpoint/credential"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Writes an external CaSS server. Requires deliberate authorization, not an automatic directory example."
    ]
  },
  "foxxi.export_clr_v1": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.issue_bbs_credential": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Configured tenant issuer key and genuine action-specific evidence"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.derive_bbs_presentation": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.verify_bbs_presentation": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.prove_competency": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Configured tenant issuer key and genuine action-specific evidence"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.launch_au_with_prereq_check": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Checks credential prerequisites then returns launched/initialized statement documents. Does not create a hosted AU session or launch URL; use cmi5_launch_signed for a real hosted launch."
    ]
  },
  "foxxi.ai_assess_competency": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "Caller-supplied assessment, evidence references and signing seed"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Constructs and signs a Hypothetical credential. No AI model or evidence review occurs; no learner achievement or issuer authority is established. No browser example should supply signing seeds."
    ]
  },
  "foxxi.countersign_assessment": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "role-gated",
    "requires": [
      "Tenant admin authorization and caller-supplied assessment/signing seed"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Produces a signed Open Badge document and original-signature reference. Does not perform human review, independently verify evidence, or persist a credential. No automatic seed-based example."
    ]
  },
  "foxxi.audit_compliance_trail": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.declare_framework_alignment": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Builds a CFAssociation document only. Does not publish a discoverable mapping or update later framework exports."
    ]
  },
  "foxxi.resolve_aligned_competency": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [
      "Two competency IRIs and supplied alignment documents"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Computes graph reachability over supplied alignment assertions. Does not verify a holder's credential, issuer authority or actual competency."
    ]
  },
  "foxxi.cohort_concept_intelligence": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.register_self_sovereign_learner": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.publish_ontology": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.bootstrap_tenant": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "owner",
    "requires": [
      "A complete sign_request envelope verified as the target pod owner"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.scorm_cloud_pull": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Operator-configured SCORM Cloud application credentials"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.scorm_cloud_register": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Operator-configured SCORM Cloud application credentials"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.upload_scorm_package": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "signed",
    "requires": [
      "An authenticated own-account signed request or supported Foxxi bearer session"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.derive_adaptive_policy": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "Supplied cohort-intelligence data"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Advisory suggestions only. No policy is stored or enforced, and question frequency is a heuristic rather than verified difficulty."
    ]
  },
  "foxxi.schedule_spaced_repetition": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [
      "Actual completion timestamps and prerequisite edges"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Computes reminder dates only. No schedule, notification or reminder delivery is created."
    ]
  },
  "foxxi.publish_course_catalog_product": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.discover_framework_registry": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "public",
    "requires": [
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.register_tutor_agent": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "Supplied profile fields"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Unpublished document builder. No marketplace registration or pod write occurs, and the claimed DID is not bound to a signer."
    ]
  },
  "foxxi.find_tutor_for_competency": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "public",
    "requires": [
      "Supplied tutor profiles and optional supplied countersign counts"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Ranks request data only. Does not search a marketplace, fetch endorsements or verify the supplied ratings/counts."
    ]
  },
  "foxxi.generate_dpia": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.manager_team_view": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.build_did_web_document": {
    "implementation": "implemented",
    "mode": "document-builder",
    "authorization": "public",
    "requires": [
      "Tenant DID, public key and bridge endpoint"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result.",
      "Constructs a DID document for separate owner-controlled publication. Does not install it on a domain or establish control of the supplied identity."
    ]
  },
  "foxxi.backup_tenant_pod": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.le_design_ab_experiment": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.judge_content_claim": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.confirm_content_judgment": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.content_judgment_calibration": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.attest_content_judgments": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.content_judgment_reputation": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.confirm_next": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.record_content_judgment": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.cross_confirm": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.best_judge": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.set_autonomy_policy": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.autonomy_status": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.weakest_claims": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.revise_claim": {
    "implementation": "implemented",
    "mode": "write",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.le_estimate_concept_difficulty": {
    "implementation": "implemented",
    "mode": "read",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy",
      "Reachable source pod and existing authorized source resources"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.le_analyze_learning_curve": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.le_calibrate_mastery_threshold": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  },
  "foxxi.le_framework_gap_analysis": {
    "implementation": "implemented",
    "mode": "computation",
    "authorization": "role-gated",
    "requires": [
      "Authenticated caller and the action's tenant-role or own-pod authorization policy"
    ],
    "notes": [
      "Generic handler instrumentation may record an operation observation separately from the requested result."
    ]
  }
};
