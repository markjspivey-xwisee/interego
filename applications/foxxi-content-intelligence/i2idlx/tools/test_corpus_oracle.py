"""Exercise the count oracle's positive and refusal cases on actual built data.

python3 -I tools/test_corpus_oracle.py <i2idlx-root>
"""
import copy
import importlib.util
import json
import pathlib
import sys
import unittest

spec = importlib.util.spec_from_file_location("corpus_oracle", pathlib.Path(__file__).with_name("corpus_oracle.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
DATA = json.loads((pathlib.Path(sys.argv[1]) / "app/build/data.json").read_text(encoding="utf-8"))


class CorpusContract(unittest.TestCase):
    def test_exact_canonical_and_declared_authored_counts(self):
        corpus = oracle.validate_corpus(DATA)
        self.assertEqual(corpus["canonical_count"], 420)
        self.assertEqual(corpus["authored_count"], 1)
        self.assertEqual(corpus["combined_count"], 421)
        self.assertEqual(corpus["authored"][0]["iri"], oracle.FRAMEWORK_IRI)

    def test_refuses_false_source_origin_identity_and_counts(self):
        mutations = {
            "combined rows passed as canonical": lambda d: d["concepts"].append(d["concepts"][0]),
            "spoofed raw count": lambda d: d["meta"]["counts"].update(concepts=421),
            "wrong revision": lambda d: d["meta"].update(commit="0" * 40),
            "wrong source digest": lambda d: d["authoredCatalog"]["canonicalSource"].update(graphSha256="0" * 64),
            "wrong authored authority": lambda d: d["authoredCatalog"].update(namespace="https://example.org/#"),
            "unearned asserted status": lambda d: d["authoredCatalog"].update(status="Asserted"),
            "wrong publisher": lambda d: d["authoredCatalog"].update(publisher="I2IDL"),
            "fake canonical authored IRI": lambda d: d["authoredCatalog"]["concepts"][0].update(iri="https://id.i2idl.org/concepts/competency-framework"),
            "duplicate authored concept": lambda d: d["authoredCatalog"]["concepts"].append(d["authoredCatalog"]["concepts"][0]),
            "missing declared extension": lambda d: d["authoredCatalog"].update(concepts=[]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                data = copy.deepcopy(DATA)
                mutate(data)
                with self.assertRaises(AssertionError):
                    oracle.validate_corpus(data)


unittest.main(argv=[sys.argv[0]])
