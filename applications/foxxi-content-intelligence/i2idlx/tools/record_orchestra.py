"""Start the recording harness for an orchestrated run (app/tools/orc_server.js) on localhost.

python3 -I tools/record_orchestra.py <i2idlx-root> [port] [trace.json] [--resume]

Bundles the harness with the page's own tools and sandbox (app/src/orc/world.js) and serves them on
127.0.0.1 (default port 7811), writing every call to the trace (default app/build/orc-trace.json) as it
happens. Agents act through app/tools/orc_cli.mjs with ORC_AGENT, ORC_STEP and ORC_PORT set; the person
recording decides the gate with POST /gate. --resume rebuilds the sandbox from an existing trace and
appends to it. Needs app/build/data.json (tools/build_app.py) and the app's node_modules. Stop it with Ctrl-C.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
APP = ROOT / "app"
rest = [a for a in sys.argv[2:] if a != "--resume"]
port = rest[0] if rest else "7811"
trace = pathlib.Path(rest[1]).resolve() if len(rest) > 1 else APP / "build" / "orc-trace.json"
# The same stand-ins tools/check_orchestra.py bundles with: the embedded data comes from the file named on
# the command line, and React is never rendered.
BANNER = ("globalThis.document={getElementById:()=>({textContent:require('fs').readFileSync(process.argv[2],'utf8')})};globalThis.window={};"
          "globalThis.React={createContext:()=>({}),useState:()=>[null,()=>{}],useEffect:()=>{},useRef:()=>({}),useCallback:(f)=>f,"
          "useMemo:(f)=>f(),useContext:()=>null,createElement:()=>null};")
subprocess.run([str(APP / "node_modules/.bin/esbuild"), "tools/orc_server.js", "--bundle", "--platform=node", "--format=cjs",
                "--outfile=build/orc-server.cjs", "--log-level=warning", "--banner:js=" + BANNER], cwd=APP, check=True)
try:
    code = subprocess.run(["node", "build/orc-server.cjs", "build/data.json", port, str(trace)]
                          + (["--resume"] if "--resume" in sys.argv else []), cwd=APP).returncode
except KeyboardInterrupt:
    code = 0
print(f"\nstopped; the trace is in {trace}")
sys.exit(max(code, 0))
