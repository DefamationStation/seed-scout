"""Exercise the running app against the installed snapshot (no world saves)."""
import json, time, unittest, urllib.request, urllib.error
BASE="http://127.0.0.1:8877"
def api(path, data=None):
    req=urllib.request.Request(BASE+path, data=None if data is None else json.dumps(data).encode(), headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))
def stopped():
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        state=api("/api/status")
        if not state["running"]:
            assert not state["error"],state["error"]
            return state
        time.sleep(.05)
    raise AssertionError("Search did not stop")
class SnapshotTests(unittest.TestCase):
    def test_catalog_and_known_seed(self):
        c=api("/api/status")["catalog"]
        self.assertIn("sulfur_caves",c["biomes"])
        r=api("/api/inspect",{"seed":"123","features":[{"kind":"structure","key":"villages","radius":1000},{"kind":"structure","key":"trial_chambers","radius":1000}]})
        self.assertTrue(r["match"])
        coords={f["key"]:(f["x"],f["z"]) for f in r["features"]}
        self.assertEqual(coords,{"villages":(-288,272),"trial_chambers":(224,176)})
        self.assertEqual(r,api("/api/inspect",{"seed":"123","features":[{"kind":"structure","key":"villages","radius":1000},{"kind":"structure","key":"trial_chambers","radius":1000}]}))
    def test_custom_origin_and_biome(self):
        r=api("/api/inspect",{"seed":"-9223372036854775808","anchor":"custom","x":-300,"z":400,"features":[{"kind":"biome","key":"plains","radius":1500}]})
        self.assertEqual(r["seed"],"-9223372036854775808")
        if r["match"]:
            self.assertEqual((r["anchorX"],r["anchorZ"]),(-300,400))
            self.assertLessEqual(r["features"][0]["distance"],1500)
    def test_parallel_budget_and_resume(self):
        req={"seed":"0","threads":4,"limit":20,"maxMatches":100,"features":[{"kind":"structure","key":"villages","radius":1000}]}
        api("/api/start",req);s=stopped()
        self.assertEqual(s["tested"],20);self.assertEqual(s["nextSeed"],"20")
        self.assertEqual(len({r["seed"] for r in s["results"]}),len(s["results"]))
        req.update(seed="20",limit=100000,features=[{"kind":"biome","key":"mushroom_fields","radius":500}])
        api("/api/start",req);time.sleep(.2);api("/api/stop",{});s=stopped()
        # Completion can be out of order. The resume marker may repeat completed seeds,
        # but cannot jump past the earliest unfinished seed.
        self.assertGreaterEqual(int(s["nextSeed"]),20)
        self.assertLessEqual(int(s["nextSeed"]),20+s["tested"])
        api("/api/start",{**req,"seed":s["nextSeed"],"limit":2});after=stopped()
        self.assertEqual(after["tested"],2)
        self.assertEqual(int(after["nextSeed"]),int(s["nextSeed"])+2)
    def test_reject_invalid_radius(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            api("/api/inspect",{"seed":"0","features":[{"kind":"structure","key":"villages","radius":9000}]})
        self.assertEqual(e.exception.code,400)
if __name__=="__main__":unittest.main(verbosity=2)
