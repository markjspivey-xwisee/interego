"""Strict combined-corpus replay overlay checks against the actual built corpus."""
import copy
import importlib.util
import json
import pathlib
import sys
import unittest

root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("replay_overlay", pathlib.Path(__file__).with_name("replay_overlay.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
canonical_bytes = (root / "examples/orchestra/kestrel-point-v93-replay-expectations.json").read_bytes()
overlay = json.loads((root / "examples/orchestra/kestrel-point-v93-authored-replay-overlay.json").read_text(encoding="utf-8"))
data = json.loads((root / "app/build/data.json").read_text(encoding="utf-8"))


class AuthoredReplayContract(unittest.TestCase):
    def test_only_two_bound_results_change(self):
        original = json.loads(canonical_bytes)
        combined = module.apply_authored_overlay(overlay, canonical_bytes, data)
        changed = [a["id"] for a, b in zip(original["results"], combined["results"]) if a != b]
        self.assertEqual(changed, ["c9", "c11"])
        self.assertEqual(len(combined["results"]), 48)
        for a, b in zip(original["results"], combined["results"]):
            if a["id"] not in changed:
                self.assertEqual(a, b)
            else:
                self.assertEqual({k: v for k, v in a.items() if k not in ("expectedSha256", "changeReason")},
                                 {k: v for k, v in b.items() if k not in ("expectedSha256", "changeReason")})
        self.assertEqual(canonical_bytes, (root / "examples/orchestra/kestrel-point-v93-replay-expectations.json").read_bytes())

    def test_refuses_wrong_fixture_corpus_provenance_and_call_binding(self):
        mutations = {
            "wrong baseline bytes": lambda o, d: o.update(canonicalFixtureSha256="0" * 64),
            "wrong catalog version": lambda o, d: d["authoredCatalog"].update(version="0.2.0"),
            "changed authored definition": lambda o, d: d["authoredCatalog"]["concepts"][0].update(definition="Changed definition"),
            "wrong review hash": lambda o, d: d["authoredCatalog"].update(reviewedProposalSha256="0" * 64),
            "fake canonical identity": lambda o, d: d["authoredCatalog"]["concepts"][0].update(iri="https://id.i2idl.org/concepts/competency-framework"),
            "false upstream adoption": lambda o, d: o["authoredConcept"]["origin"].update(upstreamAdopted=True),
            "false asserted status": lambda o, d: o["authoredConcept"]["origin"].update(status="Asserted"),
            "wrong counts": lambda o, d: o["counts"].update(combined=422),
            "unknown override": lambda o, d: o["results"][0].update(id="c8"),
            "missing override": lambda o, d: o["results"].pop(),
            "duplicate override": lambda o, d: o["results"].append(o["results"][0]),
            "wrong tool": lambda o, d: o["results"][0].update(tool="read_concepts"),
            "wrong status": lambda o, d: o["results"][0].update(ok=False),
            "wrong input": lambda o, d: o["results"][0].update(inputSha256="0" * 64),
            "wrong canonical expectation": lambda o, d: o["results"][0].update(canonicalExpectedSha256="0" * 64),
            "malformed combined digest": lambda o, d: o["results"][0].update(combinedExpectedSha256="wildcard"),
            "missing review reason": lambda o, d: o["results"][0].update(changeReason=""),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                candidate, corpus = copy.deepcopy(overlay), copy.deepcopy(data)
                mutate(candidate, corpus)
                with self.assertRaises((AssertionError, ValueError)):
                    module.apply_authored_overlay(candidate, canonical_bytes, corpus)


unittest.main(argv=[sys.argv[0]])
