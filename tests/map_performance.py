"""Non-destructive map checks and an optional cold-view benchmark against a running app.

python tests/map_performance.py --base http://127.0.0.1:8877 --benchmark
Does not start searches or change saved seeds/catalogues.
"""
import argparse, concurrent.futures, gzip, json, math, pathlib, sys, threading, time, unittest
import urllib.error, urllib.parse, urllib.request
from unittest.mock import Mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app import Engine
from collections import OrderedDict

BASE = 'http://127.0.0.1:8877'

def tile(seed='-6119735942276059334', x=0, z=0, step=128, mode='overview', compressed=True, **extra):
    query = urllib.parse.urlencode(dict(v=3, seed=seed, x=x, z=z, step=step, mode=mode, **extra))
    request = urllib.request.Request(BASE + '/api/tile?' + query,
                                   headers={'Accept-Encoding': 'gzip' if compressed else 'identity'})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
        decoded = gzip.decompress(raw) if response.headers.get('Content-Encoding') == 'gzip' else raw
        return json.loads(decoded), len(raw), dict(response.headers)

class MapTests(unittest.TestCase):
    def test_zoom_levels_use_the_same_terrain(self):
        water_samples = 0
        for seed in ('123', '18', '-6119735942276059334', '-8259522370475828954'):
            fine, _, _ = tile(seed=seed, x=0, z=0, step=4, mode='terrain')
            coarse, _, _ = tile(seed=seed, x=0, z=0, step=8, mode='overview')
            self.assertEqual(coarse['mode'], 'terrain')
            for row in range(16):
                for col in range(16):
                    a, b = row*2*32+col*2, row*32+col
                    self.assertEqual(fine['elevation'][a], coarse['elevation'][b])
                    self.assertEqual(fine['water'][a], coarse['water'][b])
                    self.assertEqual(fine['palette'][fine['biomes'][a]], coarse['palette'][coarse['biomes'][b]])
                    water_samples += fine['water'][a]
            # A large jump in scale must not change the value at a shared world coordinate.
            for step in (32, 256, 1024):
                distant, _, _ = tile(seed=seed, x=0, z=0, step=step)
                self.assertEqual(fine['elevation'][0], distant['elevation'][0])
                self.assertEqual(fine['water'][0], distant['water'][0])
                self.assertEqual(fine['palette'][fine['biomes'][0]], distant['palette'][distant['biomes'][0]])
        self.assertGreater(water_samples, 0, 'Regression must cover actual water as well as land')

    def test_screenshot_location_keeps_water_and_biome(self):
        # Reproduces the earlier inspector screenshot: X52/Z22, sunflower plains, ground Y56.
        for step in (1, 4, 8, 256):
            data, _, _ = tile(seed='-8259522370475828954', x=52, z=22, step=step)
            self.assertTrue(data['water'][0])
            self.assertEqual(data['elevation'][0], 56)
            self.assertEqual(data['palette'][data['biomes'][0]], 'sunflower_plains')

    def test_individual_blocks_match_inspector(self):
        seed = '-6119735942276059334'
        for step in (1, 2):
            data, _, _ = tile(seed=seed, x=32, z=0, step=step, mode='terrain')
            for x, z in ((52, 22), (50, 22), (52, 24)):
                payload = json.dumps(dict(seed=seed, x=x, z=z)).encode()
                request = urllib.request.Request(BASE + '/api/point', data=payload, headers={'Content-Type': 'application/json'})
                point = json.load(urllib.request.urlopen(request, timeout=120))
                i = ((z-data['z'])//step)*32 + (x-data['x'])//step
                self.assertEqual(point['groundY'], data['elevation'][i])
                self.assertEqual(point['biome'], data['palette'][data['biomes'][i]])
                self.assertEqual(point['water'], data['water'][i])
                self.assertIsInstance(point['surfaceBlock'], str)
                self.assertNotEqual(point['surfaceBlock'], 'air')
        data, _, _ = tile(seed=seed, x=-32, z=-32, step=1, mode='terrain')
        self.assertEqual(len(data['biomes']), 1024)

    def test_transport_and_modes(self):
        overview, packed, headers = tile()
        plain, unpacked, _ = tile(compressed=False)
        self.assertEqual(overview, plain)
        self.assertLess(packed, unpacked / 2)
        self.assertEqual(headers['Content-Encoding'], 'gzip')
        self.assertIn('immutable', headers['Cache-Control'])
        self.assertEqual(int(headers['Content-Length']), packed)
        self.assertEqual(overview['mode'], 'terrain')
        for field in ('biomes', 'elevation', 'water'):
            self.assertEqual(len(overview[field]), 1024)
        detailed, _, _ = tile(step=4, mode='terrain')
        self.assertEqual(detailed['mode'], 'terrain')
        # The inspector remains a full terrain check, even after overview tiles were cached.
        payload = json.dumps(dict(seed=detailed['seed'], x=0, z=0)).encode()
        request = urllib.request.Request(BASE + '/api/point', data=payload, headers={'Content-Type': 'application/json'})
        point = json.load(urllib.request.urlopen(request, timeout=120))
        self.assertEqual(point['groundY'], detailed['elevation'][0])
        self.assertEqual(point['biome'], detailed['palette'][detailed['biomes'][0]])

    def test_fast_columns_match_the_game(self):
        # Tiles share one noise chunk (1-2 blocks per sample) or read sliced columns (4 and up).
        # Both must give what the game's own full column gives, sample for sample.
        for seed, x, z in (('123', 2000000, 2000000), ('-6119735942276059334', -6016, -6016), ('18', -700416, -700416)):
            for step in (1, 2, 4, 8, 16):
                fast, _, _ = tile(seed=seed, x=x, z=z, step=step, mode='terrain')
                exact, _, _ = tile(seed=seed, x=x, z=z, step=step, mode='terrain', check='columns')
                for field in ('palette', 'biomes', 'elevation', 'water'):
                    self.assertEqual(fast[field], exact[field], f'{field} differs for seed {seed} at step {step}')

    def test_batches_return_the_same_tiles(self):
        query = urllib.parse.urlencode(dict(seed='123', step=8, mode='terrain', at='0,0;256,0;-256,512'))
        with urllib.request.urlopen(BASE + '/api/tiles?' + query, timeout=120) as response:
            batch = json.load(response)['tiles']
        self.assertEqual(batch, [tile(seed='123', x=x, z=z, step=8, mode='terrain')[0] for x, z in ((0, 0), (256, 0), (-256, 512))])
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(BASE + '/api/tiles?' + urllib.parse.urlencode(dict(seed='123', step=8, mode='terrain', at='0')), timeout=120)

    def test_stream_returns_identical_tiles(self):
        for mode,step in (('terrain',1),('terrain',8),('quick',32)):
            places=((0,0),(-256,512),(256,0))
            query=urllib.parse.urlencode(dict(seed='123',step=step,mode=mode,at=';'.join(f'{x},{z}' for x,z in places)))
            with urllib.request.urlopen(BASE+'/api/tile-stream?'+query,timeout=120) as response:
                records=[json.loads(line) for line in response]
            self.assertEqual(sorted(r['index'] for r in records),[0,1,2])
            records.sort(key=lambda r:r['index'])
            self.assertEqual([r['tile'] for r in records],[tile(seed='123',x=x,z=z,step=step,mode=mode)[0] for x,z in places])

    def test_quick_overview_follows_terrain(self):
        # Wide views use the quick biome map: no terrain columns, water only where the biome is ocean or river.
        same = total = 0
        for seed in ('123', '-6119735942276059334'):
            for step in (32, 128):
                exact, _, _ = tile(seed=seed, x=-step*32, z=0, step=step, mode='terrain')
                quick, _, _ = tile(seed=seed, x=-step*32, z=0, step=step, mode='quick')
                self.assertEqual(quick['mode'], 'quick')
                for field in ('biomes', 'elevation', 'water'):
                    self.assertEqual(len(quick[field]), 1024)
                for i in range(1024):
                    name = quick['palette'][quick['biomes'][i]]
                    self.assertEqual(quick['water'][i], 'ocean' in name or 'river' in name)
                    self.assertNotIn('caves', name)
                    same += name == exact['palette'][exact['biomes'][i]]
                    total += 1
        self.assertGreater(same / total, .9)

    def test_coarse_negative_and_large_seed(self):
        for step in (512, 1024):
            data, _, _ = tile(seed='-9223372036854775808', x=-step*32, z=-step*32, step=step)
            self.assertEqual(data['seed'], '-9223372036854775808')
            self.assertTrue(all(0 <= b < len(data['palette']) for b in data['biomes']))
        for patch in ({'step': 3}, {'mode': 'unknown'}, {'seed': '9223372036854775808'}):
            with self.assertRaises(urllib.error.HTTPError) as error:
                tile(**patch)
            self.assertEqual(error.exception.code, 400)

    def test_duplicate_requests_share_work_and_retry_failure(self):
        engine = Engine.__new__(Engine)
        engine.lock = threading.RLock()
        engine.tiles = OrderedDict()
        engine.tile_pending = {}
        engine.counter = 0
        entered, release = threading.Event(), threading.Event()
        def work(request):
            entered.set()
            self.assertTrue(release.wait(5))
            return {'mode': request['mode']}
        engine.rpc = Mock(side_effect=work)
        request = dict(seed='123', x=0, z=0, step=128, mode='overview')
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            jobs = [pool.submit(engine.tile, request) for _ in range(8)]
            self.assertTrue(entered.wait(5))
            release.set()
            self.assertEqual([job.result() for job in jobs], [{'mode': 'terrain'}] * 8)
        self.assertEqual(engine.rpc.call_count, 1)
        engine.tile({**request, 'mode': 'terrain'})
        self.assertEqual(engine.rpc.call_count, 1)
        engine.rpc.side_effect = ValueError('temporary failure')
        with self.assertRaises(ValueError): engine.tile({**request, 'x': 4096})
        self.assertFalse(engine.tile_pending)
        engine.rpc.side_effect = lambda request: {'ok': True}
        self.assertEqual(engine.tile({**request, 'x': 4096}), {'ok': True})

def benchmark():
    # A desktop view with a 500-block scale bar and the maximum 512-block tile size.
    width, height, bpp, cx, cz = 1856, 1000, 5, 1000000, 1000000
    def jobs(step):
        span = step * 32
        return [dict(x=x*span, z=z*span, step=step)
                for z in range(math.floor((cz-height*bpp/2)/span), math.ceil((cz+height*bpp/2)/span))
                for x in range(math.floor((cx-width*bpp/2)/span), math.ceil((cx+width*bpp/2)/span))]
    report = {'widthBlocks': width*bpp, 'heightBlocks': height*bpp,
              'oldTerrainTileCount': len(jobs(4))}
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        def run(name, request):
            began = time.perf_counter()
            sizes = list(pool.map(lambda job: tile(**job)[1], request))
            report[name] = {'tiles': len(request), 'seconds': round(time.perf_counter()-began, 3), 'bytes': sum(sizes)}
        def batches(name, request, size=8):
            groups = [request[i:i+size] for i in range(0, len(request), size)]
            def fetch(group):
                query = urllib.parse.urlencode(dict(seed='-6119735942276059334', step=group[0]['step'], mode='terrain', at=';'.join(f"{j['x']},{j['z']}" for j in group)))
                with urllib.request.urlopen(urllib.request.Request(BASE + '/api/tiles?' + query, headers={'Accept-Encoding': 'gzip'}), timeout=120) as response: return len(response.read())
            began = time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(3) as three: sizes = list(three.map(fetch, groups))
            report[name] = {'tiles': len(request), 'requests': len(groups), 'seconds': round(time.perf_counter()-began, 3), 'bytes': sum(sizes)}
        # The way the map asks: three requests at a time, eight tiles each.
        batches('detail', jobs(16))
        cx = cz = 1100000
        for name, bpp, step in (('scale200', 2, 4), ('scale100', 1, 2), ('scale50', .5, 1)):
            batches(name, jobs(step))
        # The same window zoomed all the way out (64 blocks per pixel): quick tiles, 128 blocks per sample.
        bpp, cx, cz = 64, 3000000, 3000000
        report['widest'] = {'widthBlocks': width*bpp, 'heightBlocks': height*bpp, 'tilesAt16BlockSampling': len(jobs(16))}
        run('widestQuick', [dict(job, mode='quick') for job in jobs(128)])
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default=BASE)
    parser.add_argument('--benchmark', action='store_true')
    args = parser.parse_args()
    BASE = args.base.rstrip('/')
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(MapTests))
    if result.wasSuccessful() and args.benchmark: benchmark()
    sys.exit(not result.wasSuccessful())
