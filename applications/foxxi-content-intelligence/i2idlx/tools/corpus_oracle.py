"""Strict source/extension contract shared by current workbench test oracles.

Raw data remains the pinned 420-term release. Combined GUI counts come only from
the separately declared, validated authored catalog, never a relaxed count bound.
"""
import json
import re

CANONICAL_COUNT = 420
GRAPH_REVISION = "b75261de5ad7851c1f61607091cc00e486bbbb5f"
AUTHORED_NS = "https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#"
FRAMEWORK_IRI = AUTHORED_NS + "concept-competency-framework"
SOURCE_PIN = {
    "repository": "https://github.com/blakeplock/i2idl-linked-data",
    "commit": "0754254be64f0562bab7e68d69583f2cc90aa945",
    "graphPath": "public/glossary.jsonld",
    "graphSha256": "db172a650fc34766b81a1d75ae0f351131fcd6a0623ddc4b7f2bdd3643a40e6a",
    "release": "v0.0.93",
}


def validate_corpus(data):
    canonical, meta = data["concepts"], data["meta"]
    assert len(canonical) == meta["counts"]["concepts"] == CANONICAL_COUNT, "raw canonical count changed"
    assert meta["release"] == "v0.0.93" and meta["commit"] == GRAPH_REVISION, "canonical release/revision changed"
    ids = {c["id"] for c in canonical}
    assert len(ids) == CANONICAL_COUNT and "competency-framework" not in ids, "authored term leaked into raw release"
    catalog = data["authoredCatalog"]
    assert catalog["canonicalSource"] == SOURCE_PIN, "authored catalog source pin changed"
    assert catalog["namespace"] == AUTHORED_NS and catalog["status"] == "Hypothetical", "authored authority/status changed"
    assert catalog["publisher"] == "Foxxi / I2IDL-X" and catalog["version"] == "0.1.0", "authored origin changed"
    assert catalog["reviewedProposalSha256"] == "f711272b203a8fe74dd26d71b895eca9ee39d05d5a0f8326f70a2852ebc3109b", "authored review identity changed"
    authored = catalog["concepts"]
    assert isinstance(authored, list) and authored, "missing declared authored concepts"
    authored_ids, authored_iris = set(), set()
    for c in authored:
        cid = c["id"]
        assert re.fullmatch(r"[a-z0-9][a-z0-9-]*", cid) and cid not in ids | authored_ids, "authored id collision"
        assert c["iri"] == AUTHORED_NS + "concept-" + cid and c["iri"] not in authored_iris, "wrong authored IRI"
        assert c["definitionIri"] == AUTHORED_NS + "definition-" + cid, "wrong authored definition IRI"
        assert c["definition"].strip() and c["label"].strip(), "missing authored definition/label"
        assert c["category"] in {cat["id"] for cat in data["semantic"]["categories"]}, "unknown authored category"
        assert all(cid in ids for cid in c["related"]), "unknown authored relation"
        authored_ids.add(cid)
        authored_iris.add(c["iri"])
    assert FRAMEWORK_IRI in authored_iris, "missing exact owned framework identity"
    return {"canonical": canonical, "authored": authored, "catalog": catalog,
            "canonical_count": len(canonical), "authored_count": len(authored),
            "combined_count": len(canonical) + len(authored)}


def assert_embedded_source(surface, data):
    embedded = json.loads(surface.locator("#i2-data").text_content())
    validate_corpus(embedded)
    assert embedded == data, "rendered app and checked raw source/catalog differ"


def assert_browser_corpus(surface, corpus, visit):
    """Exercise exact combined/source-only counts and owned attribution in the real GUI."""
    for lens, count in (("+ I2IDL-X", corpus["combined_count"]), ("I2IDL only", corpus["canonical_count"])):
        surface.get_by_role("button", name=lens, exact=True).click()
        visit("browse", ".lex-list .li")
        surface.wait_for_function("n => document.querySelectorAll('.lex-list .li').length === n", arg=count)
        assert surface.locator(".lex-list .li").count() == count, lens + " exact browse count"
        visit("whole", ".mapwrap svg circle")
        surface.wait_for_function("n => document.querySelectorAll('.mapwrap svg circle').length === n", arg=count)
        assert surface.locator(".mapwrap svg circle").count() == count, lens + " exact map count"
        surface.locator(".searchbtn").click()
        search = surface.locator('.palette input[role="combobox"]')
        search.wait_for()
        assert re.match(r"^Search " + str(count) + r" terms\b", search.get_attribute("placeholder") or ""), lens + " exact palette count"
        search.press("Escape")
        visit("c-competency-framework", ".definition" if lens == "+ I2IDL-X" else ".page div.note")
        if lens == "I2IDL only":
            assert surface.locator("#hw").count() == 0 and "authored I2IDL-X proposal" in surface.locator(".page div.note").inner_text(), "source-only deep link must not show authored definition"
        else:
            framework = next(c for c in corpus["authored"] if c["iri"] == FRAMEWORK_IRI)
            assert surface.locator("#hw").inner_text() == framework["label"]
            assert " ".join(surface.locator(".definition .def").text_content().split()) == " ".join(framework["definition"].split())
            assert "authored proposal" in surface.locator(".definition .def-meta").inner_text() and "no upstream adoption" in surface.locator(".definition .def-meta").inner_text(), "authored origin must be explicit"
            assert "Foxxi / I2IDL-X" in surface.locator("body").inner_text() and "Hypothetical" in surface.locator("body").inner_text()
            surface.get_by_role("button", name="Cite", exact=True).click()
            assert FRAMEWORK_IRI in surface.locator("body").inner_text(), "citation must preserve exact owned IRI"
            surface.locator("#hw").press("Escape")
    surface.get_by_role("button", name="+ I2IDL-X", exact=True).click()
    visit("home", ".hero h1")
