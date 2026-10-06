"""Exercise the running app against the installed snapshot (no world saves)."""
import json, pathlib, sys, time, unittest, urllib.request, urllib.error
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
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
        # Reported structures come from the second pass, which builds the start.
        self.assertEqual({f["confidence"] for f in r["features"]},{"Snapshot structure start confirmed"})
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
    def test_tiles_and_surface_biome(self):
        request={"seed":"18","features":[{"kind":"biome","key":"cherry_grove","radius":1000}]}
        result=api("/api/inspect",request)
        self.assertTrue(result["match"])
        point=result["features"][0]
        self.assertIn("surface-biome",point["confidence"])
        fine=api("/api/tile",{"seed":"18","x":point["x"],"z":point["z"],"step":4})
        coarse=api("/api/tile",{"seed":"18","x":point["x"],"z":point["z"],"step":16})
        self.assertEqual(fine["palette"][fine["biomes"][0]],"cherry_grove")
        self.assertEqual(fine["elevation"][0],coarse["elevation"][0])
        self.assertEqual(fine["palette"][fine["biomes"][0]],coarse["palette"][coarse["biomes"][0]])
        self.assertEqual(len(fine["biomes"]),1024)
        self.assertEqual(fine,api("/api/tile",{"seed":"18","x":point["x"],"z":point["z"],"step":4}))
        neighbouring=api("/api/tile",{"seed":"18","x":point["x"]+128,"z":point["z"],"step":4})
        self.assertNotEqual(fine["elevation"],neighbouring["elevation"])
        with self.assertRaises(urllib.error.HTTPError):
            api("/api/tile",{"seed":"18","x":0,"z":0,"step":0})
    def test_explorer_search_and_chunk_details(self):
        scan=api('/api/scan',{'seed':'123','x':8,'z':8,'features':[{'kind':'structure','key':'villages','radius':2000}]})
        self.assertGreater(len(scan['features']),1)
        self.assertTrue(any(f['x']==-288 and f['z']==272 for f in scan['features']))
        self.assertEqual(len({(f['x'],f['z']) for f in scan['features']}),len(scan['features']))
        p=api('/api/point',{'seed':'123','x':-1,'z':-17})
        self.assertEqual((p['chunkX'],p['chunkZ']),(-1,-2))
        t=api('/api/tile',{'seed':'123','x':-1,'z':-17,'step':4})
        self.assertEqual(p['biome'],t['palette'][t['biomes'][0]])
        self.assertEqual(p['groundY'],t['elevation'][0])
        opened=api('/api/open',{'seed':'-9223372036854775808','x':0,'z':0})
        self.assertEqual(opened['seed'],'-9223372036854775808')
        self.assertEqual(opened['features'],[])
    def test_biome_modes_and_worker_limits(self):
        base={"seed":"18","features":[{"kind":"biome","key":"cherry_grove","radius":1000}]}
        quick=api("/api/inspect",base);full=api("/api/inspect",{**base,"biomeMode":"exhaustive"})
        self.assertTrue(quick["match"]);self.assertTrue(full["match"])
        # The prefilter only skips samples, so it can never report a nearer point than the exhaustive scan.
        self.assertGreaterEqual(quick["features"][0]["distance"],full["features"][0]["distance"])
        c=api("/api/status")["catalog"]
        # The map performance update raised the documented cap from 8 to 16.
        self.assertIn(c["mapWorkers"],range(2,17))
        with self.assertRaises(urllib.error.HTTPError) as e:
            api("/api/start",{"seed":"0","threads":max(8,c["cores"])+1,"limit":1,"features":[{"kind":"structure","key":"villages","radius":1000}]})
        self.assertEqual(e.exception.code,400)
    def test_conditions_measured_from_another_match(self):
        village=lambda **extra:{"kind":"structure","key":"villages","radius":1000,"id":"v",**extra}
        chamber=lambda radius,**extra:{"kind":"structure","key":"trial_chambers","radius":radius,"near":"v",**extra}
        inspect=lambda *features:api("/api/inspect",{"seed":"123","features":list(features)})
        spots=lambda result:[(f["key"],f["x"],f["z"],f["distance"],(f["near"]["x"],f["near"]["z"]) if "near" in f else None) for f in result["features"]]
        # The nearest village has no trial chamber within 200 blocks of it, so the second village is the one that qualifies.
        self.assertEqual(spots(inspect(village(),chamber(200))),[("villages",-224,544,584,None),("trial_chambers",-272,672,137,(-224,544))])
        self.assertEqual(spots(inspect(village(),chamber(300))),[("villages",-288,272,397,None),("trial_chambers",-528,160,265,(-288,272))])
        both=inspect(village(count=2),chamber(600))
        self.assertEqual(spots(both),[("villages",-288,272,397,None),("trial_chambers",-528,160,265,(-288,272)),("villages",-224,544,584,None),("trial_chambers",-272,672,137,(-224,544))])
        self.assertEqual({f["confidence"] for f in both["features"]},{"Snapshot structure start confirmed"})
        # Every village within 1,000 blocks has a trial chamber within 600 of it.
        self.assertFalse(inspect(village(),chamber(600,mode="exclude"))["match"])
        # A condition on the anchor's own type does not count the anchor itself.
        self.assertEqual(spots(inspect(village(),{"kind":"structure","key":"villages","radius":400,"near":"v"}))[1],("villages",-224,544,279,(-288,272)))
        biome=spots(inspect(village(),{"kind":"biome","key":"snowy_plains","radius":200,"near":"v"}))
        self.assertEqual(biome[0][:3],("villages",400,784));self.assertEqual(biome[1][4],(400,784))
        # Without ids the same request behaves as before.
        plain=inspect({"kind":"structure","key":"villages","radius":1000},{"kind":"structure","key":"trial_chambers","radius":1000})
        self.assertEqual([(f["x"],f["z"]) for f in plain["features"]],[(-288,272),(224,176)])
        for bad in ([{"kind":"biome","key":"taiga","radius":500,"id":"v"},chamber(300)],[village(mode="exclude"),chamber(300)],
                    [village(),chamber(300,id="c"),{"kind":"structure","key":"igloos","radius":300,"near":"c"}],[{"kind":"structure","key":"villages","radius":500},chamber(300)]):
            with self.assertRaises(urllib.error.HTTPError) as e: api("/api/inspect",{"seed":"123","features":bad})
            self.assertEqual(e.exception.code,400)
    def test_saved_seeds_keep_notes(self):
        # Uses its own seed and removes it again, so seeds the user saved are left alone.
        seed="-777000111222333";before=[s for s in api("/api/saved")["seeds"] if s["seed"]!=seed]
        result=api("/api/open",{"seed":seed,"x":0,"z":0})
        try:
            saved=api("/api/saved",{"seed":seed,"result":result,"view":{"x":120.5,"z":-64,"bpp":2}})["seeds"]
            self.assertEqual(saved[0]["seed"],seed);self.assertEqual(saved[0]["note"],"");self.assertEqual(saved[1:],before)
            api("/api/saved",{"seed":seed,"note":"Build by the river"})
            entry=api("/api/saved")["seeds"][0]
            self.assertEqual((entry["note"],entry["view"],entry["result"]),("Build by the river",{"x":120.5,"z":-64.0,"bpp":2.0},result))
            with self.assertRaises(urllib.error.HTTPError) as e: api("/api/saved",{"seed":seed,"note":"x"*4001})
            self.assertEqual(e.exception.code,400)
        finally:
            self.assertEqual(api("/api/saved-delete",{"seed":seed})["seeds"],before)
    def test_rare_finds_are_catalogued_and_reused(self):
        # Works on finds it creates and removes them again, so the user's own catalogue is left as it was.
        catalogue=lambda:api("/api/catalogue")["finds"];before={f["id"] for f in catalogue()}
        mine=lambda:[f for f in catalogue() if f["id"] not in before]
        rare=[{"kind":"structure","key":"woodland_mansions","radius":800},{"kind":"structure","key":"villages","radius":300}]
        def run(**request):
            api("/api/start",{"threads":8,"maxMatches":50,"rareThreshold":100,**request});return stopped()
        try:
            first=run(seed="9000000",limit=6000,features=rare,useCatalogue=False)
            self.assertEqual((first["tested"],first["matches"]),(6000,22))
            self.assertEqual([(f["tested"],f["matches"],f["seedsPerMatch"],len(f["seeds"]),f["imported"]) for f in mine()],[(6000,22,273,22,False)])
            # The same conditions from another starting seed, with the catalogue asked for: every catalogued seed comes back before any new seed is tried.
            again=run(seed="9500000",limit=1000,features=rare,useCatalogue=True)
            reused={r["seed"] for r in again["results"] if r.get("fromCatalogue")}
            self.assertTrue({r["seed"] for r in first["results"]}<=reused);self.assertGreaterEqual(again["catalogueChecked"],22)
            self.assertEqual({r["seed"] for r in again["results"] if not r.get("fromCatalogue")},{"9500561","9500902"})
            self.assertEqual([(f["tested"],f["matches"],f["seedsPerMatch"],len(f["seeds"])) for f in mine()],[(7000,24,292,24)])
            # A looser search lists the catalogue seeds that fit, on top of the results asked for: new seeds are still tried.
            looser=run(seed="9700000",limit=50,maxMatches=3,features=[{"kind":"structure","key":"woodland_mansions","radius":2000}],rareThreshold=100000,useCatalogue=True)
            self.assertEqual(sum(1 for r in looser["results"] if r.get("fromCatalogue")),3);self.assertGreater(looser["tested"],0)
            # Left to its default, a search returns new seeds only.
            plain=run(seed="9700000",limit=50,maxMatches=3,features=[{"kind":"structure","key":"woodland_mansions","radius":2000}],rareThreshold=100000)
            self.assertFalse(any(r.get("fromCatalogue") for r in plain["results"]));self.assertEqual(plain["catalogueChecked"],0)
            # A common combination is not kept, and with the catalogue switched off none of its seeds are used.
            common=run(seed="9800000",limit=40,maxMatches=5,features=[{"kind":"structure","key":"villages","radius":1000}],useCatalogue=False)
            self.assertFalse(any(r.get("fromCatalogue") for r in common["results"]));self.assertEqual(len(mine()),1)
            # Export, remove, import: seeds are re-checked, so an invented seed and another game version are dropped.
            signature=json.dumps(mine()[0]["conditions"],sort_keys=True)
            exported=json.load(urllib.request.urlopen(BASE+"/api/catalogue-export",timeout=30))
            entry=next(f for f in exported["finds"] if json.dumps(f["conditions"],sort_keys=True)==signature)
            self.assertEqual((exported["format"],len(entry["seeds"])),("seed-scout-catalogue",24))
            api("/api/catalogue-delete",{"id":mine()[0]["id"]});self.assertEqual(mine(),[])
            tampered={**entry,"seeds":entry["seeds"]+["424242424242"]}
            summary=api("/api/catalogue-import",{"format":"seed-scout-catalogue","formatVersion":1,"finds":[tampered,{**tampered,"version":"1.0-other"}]})
            self.assertEqual(summary,{"finds":1,"seeds":24,"rejected":1,"otherVersion":1})
            self.assertEqual([(f["tested"],f["matches"],len(f["seeds"]),f["imported"]) for f in mine()],[(7000,24,24,True)])
            with self.assertRaises(urllib.error.HTTPError) as e: api("/api/catalogue-import",{"format":"something-else"})
            self.assertEqual(e.exception.code,400)
        finally:
            for f in mine(): api("/api/catalogue-delete",{"id":f["id"]})
    def test_reject_invalid_radius(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            api("/api/inspect",{"seed":"0","features":[{"kind":"structure","key":"villages","radius":9000}]})
        self.assertEqual(e.exception.code,400)
    def rejected(self,path,data):
        with self.assertRaises(urllib.error.HTTPError) as e: api(path,data)
        self.assertEqual(e.exception.code,400)
    def test_island_in_a_river(self):
        # Seed 2308435889659057025 has a dappled forest island about 120 blocks across, ringed by river, north-west of its spawn.
        island=lambda **kw: {"type":"island","within":500,"minAcross":40,"maxAcross":300,"own":"yes","biomes":[],**kw}
        found=lambda **kw: api("/api/inspect",{"seed":"2308435889659057025","features":[],"landscape":[island(**kw)]})
        match=found();self.assertTrue(match["match"])
        fact=next(f for f in match["features"] if f["kind"]=="terrain" and f["key"]=="island")
        self.assertEqual((fact["x"],fact["z"],fact["biome"],fact["own"]),(-176,-344,"dappled_forest",True))
        self.assertTrue(40<=fact["across"]<=300 and fact["distance"]<=500 and fact["sides"]>=9)
        self.assertNotIn("dappled_forest",fact["around"])
        self.assertTrue(found(biomes=["dappled_forest"])["match"])
        # Too near, too small, or the wrong biome: the island no longer fits.
        for miss in ({"within":200},{"maxAcross":80},{"minAcross":200},{"biomes":["desert"]}): self.assertFalse(found(**miss)["match"],miss)
        for bad in ({"within":8},{"minAcross":300,"maxAcross":100},{"maxAcross":5000},{"biomes":["atlantis"]},{"biomes":"plains"}):
            self.rejected("/api/inspect",{"seed":"0","features":[],"landscape":[island(**bad)]})
    def test_structure_tiles(self):
        tile=lambda x,z,size,keys=("villages",):api("/api/structures",{"seed":"123","x":x,"z":z,"size":size,"keys":list(keys)})
        quadrants=[tile(x,z,2048) for x in (-2048,0) for z in (-2048,0)]
        villages=[(f["x"],f["z"]) for q in quadrants for f in q["features"]]
        self.assertEqual(villages.count((-288,272)),1)
        self.assertEqual(len(set(villages)),len(villages))
        for q in quadrants:
            self.assertEqual(q["limited"],[])
            # A tile owns the locate positions in its half-open square, so neighbours never share one.
            self.assertTrue(all(q["x"]<=f["x"]<q["x"]+2048 and q["z"]<=f["z"]<q["z"]+2048 for f in q["features"]))
        self.assertIn({"kind":"structure","key":"villages","detail":"village_taiga","x":-288,"y":49,"z":272,"confidence":"Snapshot generation point confirmed"},quadrants[1]["features"])
        wide=[(f["x"],f["z"]) for x in (-4096,0) for z in (-4096,0) for f in tile(x,z,4096)["features"]]
        self.assertEqual(len(set(wide)),len(wide))
        self.assertEqual(sorted(v for v in wide if -2048<=v[0]<2048 and -2048<=v[1]<2048),sorted(villages))
        both=tile(0,0,4096,("villages","strongholds"))
        self.assertEqual(sorted((f["x"],f["z"]) for f in both["features"] if f["key"]=="villages"),sorted(v for v in wide if v[0]>=0 and v[1]>=0))
        self.assertEqual(both,tile(0,0,4096,("strongholds","villages")))
        for bad in ({"size":3000},{"x":1024},{"z":-100},{"x":30000128,"size":1024},{"keys":[]},{"keys":["villages","villages"]},{"keys":["castles"]},{"keys":"villages"},{"seed":"9223372036854775808"}):
            self.rejected("/api/structures",{"seed":"123","x":0,"z":0,"size":4096,"keys":["villages"],**bad})
    def test_ruined_portal_placements(self):
        placements=('on_land_surface','partly_buried','on_ocean_floor','in_mountain','underground')
        keys=['ruined_portals']+['ruined_portals_'+p for p in placements]
        self.assertTrue(set(keys)<=set(api('/api/status')['catalog']['sets']))
        groups={key:api('/api/structures',{'seed':'123','x':0,'z':0,'size':4096,'keys':[key]})['features'] for key in keys}
        coords=lambda key:{(f['x'],f['z']) for f in groups[key]}
        seen=set()
        for key in keys[1:]:
            self.assertFalse(seen & coords(key))
            seen |= coords(key)
            for f in groups[key][:1]:
                x,z=f['x'],f['z']
                for option in keys[1:]:
                    expected=option==key
                    self.assertEqual(api('/api/structure',{'seed':'123','key':option,'x':x,'z':z})['valid'],expected)
                    request={'seed':'123','anchor':'custom','x':x,'z':z,'features':[{'kind':'structure','key':option,'radius':32}]}
                    self.assertEqual(api('/api/inspect',request)['match'],expected)
                    request['features'][0]['mode']='exclude'
                    self.assertEqual(api('/api/inspect',request)['match'],not expected)
        self.assertEqual(seen,coords(keys[0]))
        self.assertEqual(len(seen),42)
        # The smaller tile has no desert or mountain portals; exercise those placements explicitly.
        for placement,x,z in (('partly_buried',4128,7840),('in_mountain',256,4480)):
            key='ruined_portals_'+placement
            self.assertTrue(api('/api/structure',{'seed':'123','key':key,'x':x,'z':z})['valid'])
            self.assertTrue(api('/api/inspect',{'seed':'123','anchor':'custom','x':x,'z':z,'features':[{'kind':'structure','key':key,'radius':32}]})['match'])
            for other in keys[1:]:
                if other!=key:self.assertFalse(api('/api/structure',{'seed':'123','key':other,'x':x,'z':z})['valid'])

    def test_family_filter_alternatives(self):
        catalog=api('/api/status')['catalog']
        variants=[catalog['variantDetails'][k] for k in catalog['structureVariants']['ruined_portals']]
        inspect=lambda seed,**filters:api('/api/inspect',{'seed':seed,'features':[{'kind':'structure','key':'ruined_portals','radius':40,**filters}]})
        # All biome choices are a wildcard, rather than requiring six different nearby portals.
        land='-465718846310429368'
        plain=inspect(land,placements=['on_land_surface'])
        self.assertTrue(plain['match'])
        self.assertEqual(plain,inspect(land,variants=variants,placements=['on_land_surface']))
        hit=plain['features'][0]
        self.assertEqual((hit['x'],hit['z'],hit['detail']),(0,0,'ruined_portal'))
        self.assertTrue(inspect(land,variants=['ruined_portal_desert',hit['detail']],placements=['on_ocean_floor','on_land_surface'])['match'])
        self.assertFalse(inspect(land,variants=['ruined_portal_desert'],placements=['on_land_surface'])['match'])
        self.assertFalse(inspect(land,variants=[hit['detail']],placements=['on_ocean_floor'])['match'])
        self.assertFalse(inspect(land,placements=['on_land_surface'],count=2)['match'])
        self.assertFalse(inspect(land,placements=['on_land_surface'],mode='exclude')['match'])
        self.assertTrue(inspect(land,variants=['ruined_portal_desert'],placements=['on_land_surface'],mode='exclude')['match'])
        # The user's above-ground swamp portal uses Minecraft's ON_OCEAN_FLOOR generation type.
        swamp='-465718846310429394'
        self.assertTrue(inspect(swamp,variants=variants,placements=['on_ocean_floor'])['match'])
        self.assertFalse(inspect(swamp,variants=variants,placements=['on_land_surface'])['match'])
        for filters in ({'variants':[]},{'placements':[]},{'variants':'ruined_portal'},
                        {'variants':['not_a_variant']},{'placements':['in_nether']},
                        {'placements':['on_land_surface'],'key':'villages'},
                        {'variants':['plains'],'key':'plains','kind':'biome'}):
            self.rejected('/api/inspect',{'seed':land,'features':[{'kind':'structure','key':'ruined_portals','radius':40,**filters}]})

    def test_huge_ruined_portals(self):
        catalog=api('/api/status')['catalog'];family='huge_ruined_portals'
        variants=[catalog['variantDetails'][k] for k in catalog['structureVariants'][family]]
        tile=lambda key:api('/api/structures',{'seed':'123','x':0,'z':0,'size':4096,'keys':[key]})['features']
        all_portals=tile('ruined_portals');huge=tile(family)
        positions=lambda items:{(f['x'],f['z']) for f in items}
        self.assertEqual(positions(huge),positions([f for f in all_portals if f['portalSize']=='huge']))
        self.assertEqual(positions(huge),{(3520,1008),(3344,3856)})
        self.assertTrue(all(f['portalTemplate'].startswith('ruined_portal/giant_portal_') for f in huge))
        self.assertEqual(positions(tile(family+'_on_land_surface')),{(3344,3856)})
        self.assertEqual(positions(tile(family+'__ruined_portal')),positions(huge))
        for hit in (huge[0],next(f for f in all_portals if f['portalSize']=='regular')):
            x,z=hit['x'],hit['z'];expected=hit['portalSize']=='huge'
            confirmed=api('/api/structure',{'seed':'123','key':family,'x':x,'z':z})
            self.assertEqual(confirmed['valid'],expected)
            if expected:self.assertEqual(confirmed['portalTemplate'],hit['portalTemplate'])
            def inspect(**filters):
                return api('/api/inspect',{'seed':'123','anchor':'custom','x':x,'z':z,'features':[{'kind':'structure','key':family,'radius':32,**filters}]})
            found=inspect(variants=variants,placements=[hit['placement']])
            self.assertEqual(found['match'],expected)
            if expected:self.assertEqual(found['features'][0]['portalSize'],'huge')
            self.assertEqual(inspect(mode='exclude')['match'],not expected)
            self.assertFalse(inspect(count=2)['match'])
            self.assertFalse(inspect(variants=['ruined_portal_desert'])['match'])
            self.assertFalse(inspect(placements=['partly_buried'])['match'])
        # A giant portal must not count itself as a nearby any-size portal (or vice versa).
        for parent,child in ((family,'ruined_portals'),('ruined_portals',family)):
            self.assertFalse(api('/api/inspect',{'seed':'123','anchor':'custom','x':3344,'z':3856,'features':[
                {'kind':'structure','key':parent,'radius':32,'id':'portal'},
                {'kind':'structure','key':child,'radius':32,'near':'portal'}]})['match'])
        self.rejected('/api/inspect',{'seed':'123','features':[{'kind':'structure','key':family,'radius':32,'placements':['in_nether']}]})
        api('/api/start',{'seed':'123','threads':1,'limit':1,'maxMatches':10,'anchor':'custom','x':3344,'z':3856,
            'features':[{'kind':'structure','key':family,'radius':32,'variants':variants,'placements':['on_land_surface']}]})
        search=stopped()
        self.assertEqual(search['tested'],1);self.assertEqual(len(search['results']),1)
        self.assertEqual(search['results'][0]['features'][0]['portalSize'],'huge')

    def test_huge_portal_subcategories_at_spawn(self):
        # Exercise the actual spawn-search path, rather than only a custom origin near a portal.
        seed='-2871510752493794479'
        feature={'kind':'structure','key':'huge_ruined_portals','radius':100}
        for filters in ({}, {'variants':['ruined_portal']}, {'placements':['on_land_surface']},
                        {'variants':['ruined_portal'],'placements':['on_land_surface']}):
            request={'seed':seed,'features':[{**feature,**filters}]}
            inspected=api('/api/inspect',request)
            self.assertTrue(inspected['match'])
            hit=inspected['features'][0]
            self.assertEqual((hit['x'],hit['z'],hit['placement'],hit['portalSize']),(128,16,'on_land_surface','huge'))
            api('/api/start',{**request,'threads':1,'limit':1,'maxMatches':10,'useCatalogue':False})
            search=stopped()
            self.assertEqual(search['tested'],1);self.assertEqual(search['matches'],1)
            self.assertEqual(search['results'][0]['features'],inspected['features'])

    def test_family_filter_catalogue_identity(self):
        from app import Engine, conditions
        engine=Engine.__new__(Engine);engine.catalog=api('/api/status')['catalog']
        variants=[engine.catalog['variantDetails'][k] for k in engine.catalog['structureVariants']['ruined_portals']]
        def identity(**filters):
            request={'seed':'123','features':[{'kind':'structure','key':'ruined_portals','radius':40,**filters}]}
            return conditions(engine.validate(request))
        self.assertEqual(identity(),identity(variants=variants))
        self.assertNotEqual(identity(),identity(placements=['on_land_surface']))
        self.assertNotEqual(identity(placements=['on_land_surface']),identity(placements=['on_ocean_floor']))
        self.assertEqual(identity(variants=['ruined_portal','ruined_portal_swamp']),
                         identity(variants=['ruined_portal_swamp','ruined_portal','ruined_portal']))
        self.assertNotEqual(identity(variants=['ruined_portal']),identity(variants=['ruined_portal_swamp']))

    def test_shipwreck_templates(self):
        catalog=api('/api/status')['catalog'];templates=catalog['structureTemplates']['shipwrecks']
        expected={'shipwreck/'+shape+suffix for shape in ('with_mast','rightsideup_full','rightsideup_fronthalf','rightsideup_backhalf',
            'sideways_full','sideways_fronthalf','sideways_backhalf','upsidedown_full','upsidedown_fronthalf','upsidedown_backhalf') for suffix in ('','_degraded')}
        self.assertEqual(set(templates),expected)
        markers=api('/api/structures',{'seed':'123','x':0,'z':0,'size':8192,'keys':['shipwrecks']})['features']
        self.assertEqual({f['shipwreckTemplate'] for f in markers},expected)
        for template in templates:
            with self.subTest(template=template):
                marker=next(f for f in markers if f['shipwreckTemplate']==template)
                other=next(t for t in templates if t!=template)
                confirmed=api('/api/structure',{'seed':'123','key':'shipwrecks','x':marker['x'],'z':marker['z']})
                self.assertTrue(confirmed['valid']);self.assertEqual(confirmed['shipwreckTemplate'],template)
                def inspect(**filters):
                    return api('/api/inspect',{'seed':'123','anchor':'custom','x':marker['x'],'z':marker['z'],
                        'features':[{'kind':'structure','key':'shipwrecks','radius':32,**filters}]})
                match=inspect(templates=[template],variants=[marker['detail']])
                self.assertTrue(match['match']);self.assertEqual(match['features'][0]['shipwreckTemplate'],template)
                self.assertTrue(inspect(templates=[other,template])['match'])
                self.assertFalse(inspect(templates=[other])['match'])
                self.assertFalse(inspect(templates=[template],variants=['shipwreck_beached' if marker['detail']=='shipwreck' else 'shipwreck'])['match'])
                self.assertFalse(inspect(templates=[template],mode='exclude')['match'])
                self.assertTrue(inspect(templates=[other],mode='exclude')['match'])
                self.assertFalse(inspect(templates=[template],count=2)['match'])
        # Filtering whole/half templates leaves the original random selection intact.
        all_templates=api('/api/inspect',{'seed':'123','anchor':'custom','x':192,'z':7056,
            'features':[{'kind':'structure','key':'shipwrecks','radius':32,'templates':templates}]})
        plain=api('/api/inspect',{'seed':'123','anchor':'custom','x':192,'z':7056,
            'features':[{'kind':'structure','key':'shipwrecks','radius':32}]})
        self.assertEqual(all_templates,plain)
        scan={'seed':'123','x':192,'z':7056,'features':[{'kind':'structure','key':'shipwrecks','radius':32,'templates':['shipwreck/with_mast']}]}
        self.assertEqual(api('/api/scan',scan)['features'][0]['shipwreckTemplate'],'shipwreck/with_mast')
        scan['features'][0]['templates']=['not_a_template'];self.rejected('/api/scan',scan)
        api('/api/start',{'seed':'123','threads':1,'limit':1,'maxMatches':10,'anchor':'custom','x':192,'z':7056,
            'features':[{'kind':'structure','key':'shipwrecks','radius':32,'templates':['shipwreck/with_mast']}]})
        search=stopped();self.assertEqual(search['matches'],1)
        self.assertEqual(search['results'][0]['features'][0]['shipwreckTemplate'],'shipwreck/with_mast')
        for filters in ({'templates':[]},{'templates':'shipwreck/with_mast'},{'templates':['not_a_template']},
                        {'templates':['shipwreck/with_mast'],'key':'villages'},
                        {'templates':['shipwreck/with_mast'],'key':'plains','kind':'biome'}):
            self.rejected('/api/inspect',{'seed':'123','features':[{'kind':'structure','key':'shipwrecks','radius':32,**filters}]})
        from app import Engine,conditions
        engine=Engine.__new__(Engine);engine.catalog=catalog
        def identity(values=None):
            feature={'kind':'structure','key':'shipwrecks','radius':100}
            if values is not None:feature['templates']=values
            return conditions(engine.validate({'seed':'123','features':[feature]}))
        self.assertEqual(identity(),identity(templates))
        self.assertNotEqual(identity(['shipwreck/with_mast']),identity(['shipwreck/with_mast_degraded']))
        self.assertEqual(identity(templates[:2]),identity([templates[1],templates[0],templates[0]]))

    def test_shipwreck_water_placement(self):
        catalog=api('/api/status')['catalog']
        self.assertEqual(set(catalog['structurePlacements']['shipwrecks']),{'afloat','surface','submerged','beached'})
        template='shipwreck/with_mast'
        for seed,x,z,placement,deck in [('139',2176,3856,'surface',64),('123',192,7056,'submerged',40),('5645',4064,1696,'afloat',64)]:
            with self.subTest(seed=seed):
                built=api('/api/structure',{'seed':seed,'key':'shipwrecks','x':x,'z':z})
                self.assertEqual(built['shipwreckTemplate'],template)
                self.assertEqual((built['placement'],built['shipDeckY'],built['waterY']),(placement,deck,62))
                if placement=='afloat':
                    self.assertEqual(built['groundedHullColumns'],0)
                    self.assertGreater(built['keelClearance'],0)
                    self.assertEqual(built['hullWaterCoverage'],100)
                    self.assertGreater(built['stand']['y'],built['waterY'])
                else:self.assertGreater(built['groundedHullColumns'],0)
                self.assertEqual(built['shipBox']['minY'],built['shipY'])
                self.assertIn('base terrain',built['placementAccuracy'])
                feature={'kind':'structure','key':'shipwrecks','radius':32,'templates':[template],'variants':['shipwreck'],'placements':[placement]}
                request={'seed':seed,'anchor':'custom','x':x,'z':z,'features':[feature]}
                matched=api('/api/inspect',request)
                self.assertTrue(matched['match']);self.assertEqual(matched['features'][0]['placement'],placement)
                self.assertEqual(api('/api/scan',{'seed':seed,'x':x,'z':z,'features':[feature]})['features'][0]['placement'],placement)
                def inspect(**change):return api('/api/inspect',{**request,'features':[{**feature,**change}]})
                # The mast and a dry deck never let a grounded wreck pass the strict floating filter.
                self.assertEqual(inspect(placements=['afloat'])['match'],placement=='afloat')
                self.assertTrue(inspect(placements=['afloat',placement])['match'])
                self.assertFalse(inspect(mode='exclude')['match'])
                self.assertEqual(inspect(placements=['afloat'],mode='exclude')['match'],placement!='afloat')
                self.assertFalse(inspect(count=2)['match'])
                self.assertFalse(inspect(templates=['shipwreck/with_mast_degraded'])['match'])
                self.assertFalse(inspect(variants=['shipwreck_beached'])['match'])
                api('/api/start',{**request,'threads':1,'limit':1,'maxMatches':10,'useCatalogue':False})
                result=stopped();self.assertEqual(result['matches'],1)
                self.assertEqual(result['results'][0]['features'],matched['features'])
                if placement=='afloat':
                    linked={**feature,'id':'ship'}
                    ocean={'kind':'biome','key':'ocean','radius':64,'near':'ship'}
                    combined=api('/api/inspect',{**request,'features':[linked,ocean]})
                    self.assertTrue(combined['match'])
                    self.assertEqual(combined['features'][0]['placement'],'afloat')
                    self.assertEqual(combined['features'][1]['near'],{'key':'shipwrecks','x':x,'z':z})
                from app import Engine,conditions
                engine=Engine.__new__(Engine);engine.catalog=catalog
                original=conditions(engine.validate(request))
                self.assertNotEqual(original,conditions(engine.validate({**request,'features':[{**feature,'placements':['surface' if placement=='afloat' else 'afloat']}]})))
                plain={**feature};plain.pop('placements')
                self.assertEqual(conditions(engine.validate({**request,'features':[plain]})),
                    conditions(engine.validate({**request,'features':[{**feature,'placements':catalog['structurePlacements']['shipwrecks']}]})))
        for feature in [{'kind':'structure','key':'shipwrecks','radius':32,'placements':['unknown']},
                        {'kind':'structure','key':'shipwrecks','radius':32,'placements':[]},
                        {'kind':'structure','key':'villages','radius':32,'placements':['afloat']},
                        {'kind':'biome','key':'ocean','radius':32,'placements':['afloat']}]:
            self.rejected('/api/inspect',{'seed':'123','features':[feature]})
            self.rejected('/api/scan',{'seed':'123','x':0,'z':0,'features':[feature]})

    def test_structure_subcategories(self):
        catalog=api('/api/status')['catalog']
        expected={'villages':5,'mineshafts':2,'ocean_ruins':2,'shipwrecks':2,'abandoned_camp':18,'ruined_portals':6,'huge_ruined_portals':6,'igloos':1}
        self.assertEqual({k:len(v) for k,v in catalog['structureVariants'].items()},expected)
        for family,keys in catalog['structureVariants'].items():
            def tile(key):return api('/api/structures',{'seed':'123','x':0,'z':0,'size':2048,'keys':[key]})['features']
            base=tile(family);seen=set()
            for key in keys:
                variants=tile(key)
                self.assertTrue(all(f['detail']==catalog['variantDetails'][key] for f in variants))
                positions={(f['x'],f['z']) for f in variants}
                self.assertFalse(seen & positions);seen |= positions
                if variants:
                    f=variants[0];x,z=f['x'],f['z']
                    self.assertTrue(api('/api/structure',{'seed':'123','key':key,'x':x,'z':z})['valid'])
                    self.assertTrue(api('/api/inspect',{'seed':'123','anchor':'custom','x':x,'z':z,'features':[{'kind':'structure','key':key,'radius':32}]})['match'])
                    if len(keys)>1:
                        other=next(k for k in keys if k!=key)
                        self.assertFalse(api('/api/structure',{'seed':'123','key':other,'x':x,'z':z})['valid'])
            self.assertEqual(seen,{(f['x'],f['z']) for f in base})
            if family=='ruined_portals':self.assertTrue(all(f['placement'] in ('on_land_surface','partly_buried','on_ocean_floor','in_mountain','underground') for f in base))

    def test_structure_confirmation(self):
        confirmed=api("/api/structure",{"seed":"123","key":"villages","x":-288,"z":272})
        inspected=api("/api/inspect",{"seed":"123","features":[{"kind":"structure","key":"villages","radius":1000}]})["features"][0]
        self.assertEqual({k:confirmed[k] for k in ("valid","kind","key","detail","x","y","z","confidence")},{"valid":True,**{k:inspected[k] for k in ("kind","key","detail","x","y","z","confidence")}})
        self.assertEqual(confirmed["box"],{"minX":-369,"minY":16,"minZ":190,"maxX":-238,"maxY":100,"maxZ":320})
        self.assertEqual(confirmed["pieces"],134)
        # One chunk east of the village there is no start.
        self.assertEqual(api("/api/structure",{"seed":"123","key":"villages","x":-272,"z":272}),{"valid":False})
        for bad in ({"key":"castles"},{"x":"west"},{"z":30100000},{"seed":""}):
            self.rejected("/api/structure",{"seed":"123","key":"villages","x":-288,"z":272,**bad})
    def test_count_min_radius_and_exclude(self):
        village=lambda **extra:{"kind":"structure","key":"villages","radius":1000,**extra}
        inspect=lambda *features,seed="123",**extra:api("/api/inspect",{"seed":seed,"features":list(features),**extra})
        spots=lambda result:[(f["x"],f["z"],f["distance"]) for f in result["features"]]
        three=inspect(village(count=3))
        self.assertEqual(spots(three),[(-288,272,397),(-224,544,584),(400,784,869)])
        self.assertEqual({f["confidence"] for f in three["features"]},{"Snapshot structure start confirmed"})
        self.assertFalse(inspect(village(count=4,radius=900))["match"])
        self.assertEqual(spots(inspect(village(minRadius=500))),[(-224,544,584)])
        self.assertFalse(inspect(village(minRadius=600,radius=800))["match"])
        self.assertEqual(inspect(village()),inspect(village(mode="within",minRadius=0,count=1)))
        # The two outermost of the three villages are 858 blocks apart.
        self.assertFalse(inspect(village(count=3),cluster=800)["match"])
        self.assertTrue(inspect(village(count=3),cluster=900)["match"])
        # Seed 123 has a trial chamber 274 blocks from spawn.
        chamber=lambda radius:{"kind":"structure","key":"trial_chambers","radius":radius,"mode":"exclude"}
        self.assertEqual(spots(inspect(village(),chamber(200))),[(-288,272,397)])
        self.assertFalse(inspect(village(),chamber(300))["match"])
        only=inspect(chamber(200))
        self.assertTrue(only["match"]);self.assertEqual(only["features"],[])
        # Snowy plains lie 258 blocks from spawn; there are no plains within 500.
        biome=lambda key,**extra:{"kind":"biome","key":key,"radius":500,**extra}
        self.assertEqual(spots(inspect(village(),biome("plains",mode="exclude"))),[(-288,272,397)])
        self.assertFalse(inspect(village(),biome("snowy_plains",mode="exclude"))["match"])
        self.assertEqual(spots(inspect(biome("snowy_plains"))),[(-120,-216,258)])
        # Seed 18 has a cherry grove 64 blocks from spawn; the nearest one beyond 600 blocks is 890 away.
        grove=lambda **extra:{"kind":"biome","key":"cherry_grove","radius":1000,**extra}
        self.assertEqual(spots(inspect(grove(minRadius=600),seed="18")),[(472,856,890)])
        self.assertFalse(inspect(grove(minRadius=600,radius=880),seed="18")["match"])
    def test_search_with_count_and_exclude(self):
        features=[{"kind":"structure","key":"villages","radius":800,"count":2},{"kind":"structure","key":"pillager_outposts","radius":800,"mode":"exclude"}]
        api("/api/start",{"seed":"0","threads":4,"limit":60,"maxMatches":100,"features":features});s=stopped()
        self.assertEqual(sorted(int(r["seed"]) for r in s["results"]),[2,4,5,12,13,17,19,25,26,27,28,34,35,39,44,45,46,48,51,52,53,57,59])
        for r in s["results"]:
            self.assertEqual([f["key"] for f in r["features"]],["villages","villages"])
            self.assertLessEqual(r["features"][0]["distance"],r["features"][1]["distance"])
            self.assertEqual(r["features"],api("/api/inspect",{"seed":r["seed"],"features":features})["features"])
    def test_reject_invalid_conditions(self):
        village=lambda **extra:{"kind":"structure","key":"villages","radius":500,**extra}
        self.assertIn("match",api("/api/inspect",{"seed":"0","features":[village(minRadius=468,count=10),village(mode="exclude",radius=100)]}))
        for bad in (village(mode="near"),village(minRadius=-1),village(minRadius=469),village(count=0),village(count=11),village(mode="exclude",count=2),village(mode="exclude",minRadius=100),{"kind":"biome","key":"plains","radius":500,"count":2}):
            self.rejected("/api/inspect",{"seed":"0","features":[bad]})
            self.rejected("/api/start",{"seed":"0","limit":1,"features":[bad]})
if __name__=="__main__":unittest.main(verbosity=2)
