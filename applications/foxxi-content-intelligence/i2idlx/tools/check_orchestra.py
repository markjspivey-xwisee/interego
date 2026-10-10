"""Check the recorded orchestrated run that Orchestrate replays (examples/orchestra/kestrel-point-run.json).

python3 -I tools/check_orchestra.py <i2idlx-root>

Every tool call is re-run, in order, against a fresh sandbox with the page's own tools (app/src/orc/world.js)
and must return exactly what the recording holds; every call must belong to its step's agent and tools; every
step must have finished; and the run must end with the staged writes approved. Needs app/build/data.json.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
APP = ROOT / "app"
RUN = ROOT / "examples" / "orchestra" / "kestrel-point-run.json"
BANNER = ("globalThis.document={getElementById:()=>({textContent:require('fs').readFileSync(process.argv[2],'utf8')})};globalThis.window={};"
          "globalThis.React={createContext:()=>({}),useState:()=>[null,()=>{}],useEffect:()=>{},useRef:()=>({}),useCallback:(f)=>f,"
          "useMemo:(f)=>f(),useContext:()=>null,createElement:()=>null};")
subprocess.run([str(APP / "node_modules/.bin/esbuild"), "tools/orc_check.js", "--bundle", "--platform=node", "--format=cjs",
                "--outfile=build/orc-check.cjs", "--log-level=warning", "--banner:js=" + BANNER], cwd=APP, check=True)
r = json.loads(subprocess.run(["node", "build/orc-check.cjs", "build/data.json", str(RUN)], cwd=APP, check=True,
                              capture_output=True, text=True).stdout)

failures = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


check(r["calls"] > 0 and r["matched"] == r["calls"], f"{r['matched']} of {r['calls']} recorded tool results reproduced exactly"
      + (f"; differ: {r['mismatches'][:6]}" if r["mismatches"] else ""))
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
