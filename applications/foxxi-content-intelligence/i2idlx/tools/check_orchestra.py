"""Check the recorded orchestrated run that Orchestrate replays (examples/orchestra/kestrel-point-run.json).

python3 -I tools/check_orchestra.py <i2idlx-root> [--migration <reviewed-expectations.json>]
    [--canonical | --authored-overlay <reviewed-combined-overlay.json>]

Every tool call is re-run, in order, against a fresh sandbox with the page's own tools (app/src/orc/world.js)
and by default must return exactly what the recording holds. --migration instead requires every exact reviewed
v93 result digest and reports historical drift separately. Every call must belong to its step's agent and tools;
every step must have finished; and the run must end with the staged writes approved. Needs app/build/data.json.
--canonical keeps the original 420-term oracle. --authored-overlay separately checks the combined corpus,
binding exactly two reviewed search-result changes to that unchanged fixture and the actual authored catalog.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root")
parser.add_argument("--migration", type=pathlib.Path, help="exact reviewed v93 replay expectations; the original trace remains unchanged")
corpus = parser.add_mutually_exclusive_group()
corpus.add_argument("--canonical", action="store_true", help="check the original 420-term source corpus, excluding its separate authored catalog")
corpus.add_argument("--authored-overlay", type=pathlib.Path, help="two reviewed combined-corpus result overrides bound to the canonical fixture and authored catalog")
args = parser.parse_args()
if (args.canonical or args.authored_overlay) and not args.migration:
    parser.error("--canonical and --authored-overlay require --migration")
ROOT = pathlib.Path(args.root).resolve()
APP = ROOT / "app"
RUN = ROOT / "examples" / "orchestra" / "kestrel-point-run.json"
BANNER = ("globalThis.document={getElementById:()=>({textContent:require('fs').readFileSync(process.argv[2],'utf8')})};globalThis.window={};"
          "globalThis.React={createContext:()=>({}),useState:()=>[null,()=>{}],useEffect:()=>{},useRef:()=>({}),useCallback:(f)=>f,"
          "useMemo:(f)=>f(),useContext:()=>null,createElement:()=>null};")
subprocess.run([str(APP / "node_modules/.bin/esbuild"), "tools/orc_check.js", "--bundle", "--platform=node", "--format=cjs",
                "--outfile=build/orc-check.cjs", "--log-level=warning", "--banner:js=" + BANNER], cwd=APP, check=True)
with tempfile.TemporaryDirectory(prefix="i2idlx-replay-") as temporary:
    command = ["node", "build/orc-check.cjs", "build/data.json", str(RUN)]
    expected = args.migration.resolve() if args.migration else None
    data = json.loads((APP / "build" / "data.json").read_text(encoding="utf-8"))
    if args.canonical:
        if len(data["concepts"]) != 420 or data["meta"]["counts"]["concepts"] != 420:
            raise ValueError("Canonical replay requires the raw 420-term source corpus")
        canonical = {k: v for k, v in data.items() if k != "authoredCatalog"}
        source = pathlib.Path(temporary) / "canonical-data.json"
        source.write_text(json.dumps(canonical, ensure_ascii=False), encoding="utf-8")
        command[2] = str(source)
    if args.authored_overlay:
        import importlib.util
        spec = importlib.util.spec_from_file_location("replay_overlay", pathlib.Path(__file__).with_name("replay_overlay.py"))
        overlay_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(overlay_module)
        overlay = json.loads(args.authored_overlay.read_text(encoding="utf-8"))
        combined = overlay_module.apply_authored_overlay(overlay, expected.read_bytes(), data)
        expected = pathlib.Path(temporary) / "combined-expectations.json"
        expected.write_text(json.dumps(combined, ensure_ascii=False), encoding="utf-8")
    if expected:
        command.append(str(expected))
    r = json.loads(subprocess.run(command, cwd=APP, check=True, capture_output=True, text=True).stdout)

failures = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


if args.migration:
    if args.authored_overlay:
        print("INFO combined corpus: 420 canonical + 1 authored Hypothetical concept; only c9/c11 use the reviewed overlay, all other 46 expectations unchanged")
    elif args.canonical:
        print("INFO canonical corpus: the original 420-term source and unchanged v93 migration expectations")
    print(f"INFO historical recording: {r['matched']} of {r['calls']} tool results reproduced exactly; differ: {r['mismatches']}")
    migration = r["migration"]
    check(migration["boundCalls"] == 48 and migration["reviewedChanges"] == 11 and migration["unchanged"] == 37,
          "48 original call identities, inputs and recorded result digests bound; 11 reviewed changes and 37 identical expectations")
    check(migration["matched"] == r["calls"] == 48, f"{migration['matched']} of {r['calls']} v0.0.93 migration tool results reproduced exactly"
          + ("; actual digest mismatch: " + json.dumps(migration["mismatches"][:6]) if migration["mismatches"] else ""))
else:
    check(r["calls"] > 0 and r["matched"] == r["calls"], f"{r['matched']} of {r['calls']} recorded tool results reproduced exactly"
          + (f"; differ: {r['mismatches'][:6]}" if r["mismatches"] else ""))
# A result amended after recording is listed under amendments: the value it changed, what was recorded there, when and
# why. The recording must hold the amended value, so each entry stays true of the file.
trace = json.loads(RUN.read_text())
results = {e["id"]: e for e in trace["events"] if e["k"] == "result"}
amended = []
for a in trace.get("amendments", []):
    node = results.get(a["result"])
    for name, index in re.findall(r"(\w+)(?:\[(\d+)\])?", a["path"]):
        node = node.get(name) if isinstance(node, dict) else None
        if index and isinstance(node, list):
            node = node[int(index)] if int(index) < len(node) else None
    amended.append(node == a["now"] and a["recorded"] != a["now"] and bool(a.get("why")) and bool(a.get("on")))
check(all(amended), f"{len(amended)} amended result(s), each holding its amended value, with what was recorded, when and why")
check(not r["wrongAgent"], "every call was made by its step's agent")
check(not r["wrongTool"], "every call used one of its step's tools")
check(r["errors"] == 0, f"{r['errors']} tool errors in the recorded run")
check(all(v in ("done", "skipped") for v in r["steps"].values()) and len(r["steps"]) == 12, f"all 12 steps settled: {r['steps']}")
check(len(r["agents"]) == 8, f"all eight agents acted: {', '.join(r['agents'])}")
check(r["final"]["gate"] == "approved" and r["final"]["approved"] == r["final"]["staged"] > 0, f"the run ends with its staged writes approved: {r['final']}")
# The staged writes are what the relay would receive: each must conform to the I2IDL-X shapes it names.
import rdflib
from pyshacl import validate
shapes = rdflib.Graph().parse(ROOT / "dist" / "i2idlx-shapes.ttl", format="turtle")
ports = {p["id"]: p for p in json.loads((APP / "build" / "data.json").read_text())["ports"]}
for s in r["calls_staged"]:
    call, port = s["call"], ports[s["port"]]
    required = [x["n"] for x in port["expects"]["props"] if x["req"]]
    check(all(call.get(k) for k in required), f"{s['id']} ({s['port']}) carries every required input: {', '.join(required)}")
    data = rdflib.Graph().parse(data=call["graph_content"], format="turtle")
    ok, _, text = validate(data, shacl_graph=shapes, inference="rdfs", abort_on_first=False)
    check(ok, f"{s['id']}: its {len(data)} triples conform to the I2IDL-X shapes" + ("" if ok else "\n" + text[:600]))
print(f"\n{len(failures)} failures")
sys.exit(1 if failures else 0)
