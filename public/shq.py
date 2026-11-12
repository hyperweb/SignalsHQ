#!/usr/bin/env python3
"""Signals HQ runner helper. Reads and writes Signals HQ data through the runner API.

Setup each run:
  curl -s https://signals.hyperweb.ca/shq.py -o /tmp/shq.py
  export SHQ_TOKEN=<runner token>          # SHQ_URL defaults to https://signals.hyperweb.ca

Spaces: "hq" (desks, onboarding, hq) and "desk:<desk id>" (workspace, audiences, signals, leads, runs, requests).
Paths: "<collection>/<doc id>", e.g. "workspace/profile".

  python3 /tmp/shq.py spaces
  python3 /tmp/shq.py list   <space> <collection> [--where FIELD OP JSON]... [--order FIELD asc|desc] [--limit N] [--out DIR]
  python3 /tmp/shq.py get    <space> <path>
  python3 /tmp/shq.py set    <space> <path> <json | @file.json> [--if-version N]
  python3 /tmp/shq.py update <space> <path> <json | @file.json> [--if-version N]   (deep merge; {"__delete__": true} removes a field)
  python3 /tmp/shq.py delete <space> <path> [--if-version N]
  python3 /tmp/shq.py batch  <space> @ops.json      ops: [{"op":"set|update|delete","path":"...","data":{...},"ifVersion":N}]
  python3 /tmp/shq.py delete-space desk:<id>        (only for a desk HQ marked "Delete requested")

Output is JSON. list and get include each doc's "version"; pass it back as --if-version on writes.
A write to a doc that changed since you read it fails with code "stale": re-read and redo it.
"""
import json, os, sys, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("SHQ_URL", "https://signals.hyperweb.ca").rstrip("/") + "/api/runner"
TOKEN = os.environ.get("SHQ_TOKEN", "")

def call(method, path, body=None, query=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: err = json.loads(e.read())
        except Exception: err = {"code": "http_%d" % e.code, "message": str(e)}
        print(json.dumps({"error": err}), file=sys.stderr)
        sys.exit(2)
    except (urllib.error.URLError, OSError) as e:
        print(json.dumps({"error": {"code": "unreachable", "message": "Couldn't reach Signals HQ: %s" % getattr(e, "reason", e)}}), file=sys.stderr)
        sys.exit(3)

def load(arg):
    if arg.startswith("@"):
        with open(arg[1:]) as f: return json.load(f)
    return json.loads(arg)

def opt(args, name, n=1, many=False):
    out = []
    while name in args:
        i = args.index(name); vals = args[i + 1:i + 1 + n]; del args[i:i + 1 + n]; out.append(vals)
    if many: return out
    return out[-1] if out else None

def main(a):
    if not a or a[0] in ("-h", "--help"): print(__doc__); return
    cmd = a.pop(0)
    if not TOKEN: sys.exit("Set SHQ_TOKEN first")
    if cmd == "spaces": res = call("GET", "/spaces")
    elif cmd == "list":
        where = [[f, op, json.loads(v)] for f, op, v in opt(a, "--where", 3, many=True)]
        order = opt(a, "--order", 2); limit = opt(a, "--limit"); out = opt(a, "--out")
        space, coll = a
        res = call("POST", "/query", {"space": space, "coll": coll, "where": where,
            "orderBy": [order] if order else [], "limit": int(limit[0]) if limit else None})
        if out:
            d = os.path.join(out[0], coll); os.makedirs(d, exist_ok=True)
            for doc in res["docs"]:
                with open(os.path.join(d, doc["id"] + ".json"), "w") as f: json.dump(doc, f, indent=1)
            res = {"saved": len(res["docs"]), "dir": d, "ids": [[x["id"], x["version"]] for x in res["docs"]]}
    elif cmd == "get":
        space, path = a; res = call("GET", "/doc", query={"space": space, "path": path})
    elif cmd in ("set", "update"):
        iv = opt(a, "--if-version"); space, path, data = a
        body = {"space": space, "path": path, "data": load(data)}
        if iv: body["ifVersion"] = int(iv[0])
        res = call("PUT" if cmd == "set" else "PATCH", "/doc", body)
    elif cmd == "delete":
        iv = opt(a, "--if-version"); space, path = a
        q = {"space": space, "path": path}
        if iv: q["ifVersion"] = iv[0]
        res = call("DELETE", "/doc", query=q)
    elif cmd == "batch":
        space, ops = a; done = []
        for o in load(ops):
            body = {"space": space, "path": o["path"]}
            if o.get("ifVersion"): body["ifVersion"] = int(o["ifVersion"])
            if o["op"] == "delete":
                q = {"space": space, "path": o["path"]}
                if o.get("ifVersion"): q["ifVersion"] = str(o["ifVersion"])
                call("DELETE", "/doc", query=q); done.append([o["path"], "deleted"])
            else:
                body["data"] = o["data"]
                r = call("PUT" if o["op"] == "set" else "PATCH", "/doc", body); done.append([o["path"], r.get("version")])
        res = {"done": done}
    elif cmd == "delete-space":
        space = a[0]; res = call("POST", "/delete-space", {"space": space, "confirm": space})
    else: sys.exit("Unknown command " + cmd)
    print(json.dumps(res, ensure_ascii=False))

if __name__ == "__main__": main(sys.argv[1:])
