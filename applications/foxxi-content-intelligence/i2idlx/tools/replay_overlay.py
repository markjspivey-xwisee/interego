"""Bind two reviewed authored search deltas to the unchanged canonical replay oracle."""
import copy
import hashlib
import importlib.util
import json
import pathlib

spec = importlib.util.spec_from_file_location("corpus_oracle", pathlib.Path(__file__).with_name("corpus_oracle.py"))
corpus_oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus_oracle)


def catalog_digest(catalog):
    encoded = json.dumps(catalog, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def apply_authored_overlay(overlay, canonical_bytes, data):
    def require(ok, message):
        if not ok:
            raise ValueError("Invalid combined-corpus replay overlay: " + message)

    require(overlay.get("v") == 1 and overlay.get("scope") == "canonical-v93-plus-authored", "unknown version or scope")
    require(overlay.get("canonicalFixtureSha256") == hashlib.sha256(canonical_bytes).hexdigest(), "canonical fixture bytes differ")
    baseline = json.loads(canonical_bytes)
    corpus = corpus_oracle.validate_corpus(data)
    catalog = corpus["catalog"]
    require(overlay.get("catalogSha256") == catalog_digest(catalog), "authored catalog bytes differ")
    require(overlay.get("counts") == {"canonical": corpus["canonical_count"], "authored": corpus["authored_count"], "combined": corpus["combined_count"]}, "corpus counts differ")
    framework = next(c for c in corpus["authored"] if c["iri"] == corpus_oracle.FRAMEWORK_IRI)
    origin = {"kind": "authored", "publisher": catalog["publisher"], "catalogVersion": catalog["version"],
              "scheme": catalog["namespace"] + "AuthoredConcepts", "status": catalog["status"], "authors": catalog["authors"],
              "reviewedProposalSha256": catalog["reviewedProposalSha256"], "proposedCanonicalIri": framework["proposedCanonicalIri"], "upstreamAdopted": False}
    require(overlay.get("authoredConcept") == {"iri": framework["iri"], "origin": origin}, "owned concept identity or provenance differs")
    rows = overlay.get("results", [])
    require(isinstance(rows, list) and [r.get("id") for r in rows] == ["c9", "c11"], "only the ordered c9/c11 overrides are permitted")
    combined = copy.deepcopy(baseline)
    by_id = {r["id"]: r for r in combined["results"]}
    for row in rows:
        original = by_id[row["id"]]
        require(row.get("tool") == original["tool"] == "search_glossary" and row.get("ok") is original["ok"], "call tool or status differs")
        require(row.get("inputSha256") == original["inputSha256"], "call input differs")
        require(row.get("canonicalExpectedSha256") == original["expectedSha256"], "canonical expected result differs")
        digest = row.get("combinedExpectedSha256")
        require(isinstance(digest, str) and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest) and digest != original["expectedSha256"], "invalid combined expected digest")
        require(isinstance(row.get("changeReason"), str) and bool(row["changeReason"].strip()), "missing reviewed change reason")
        original["expectedSha256"] = digest
        original["changeReason"] += " Authored overlay: " + row["changeReason"]
    require(sum(a != b for a, b in zip(baseline["results"], combined["results"])) == 2, "unexpected result changes")
    return combined
