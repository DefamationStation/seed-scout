"""The engine in this checkout beside an earlier one: the same seeds must give the same matches, and how fast.

    python tests/engine_compare.py                      compare with the last commit
    python tests/engine_compare.py --baseline v0.1.31   compare with a release
    python tests/engine_compare.py --only biome         only the searches whose name contains "biome"

Both engines are compiled into a new folder under runtime/search-bench and run in their own Java processes, away
from the app, its saved searches and its catalogue. Every match is compared whole: seed, spawn, positions, heights.
"""
import argparse, json, pathlib, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT))
from build import prepare, JDK
p = argparse.ArgumentParser(); p.add_argument('--baseline', default='HEAD'); p.add_argument('--only', nargs='*', default=[]); p.add_argument('--threads', type=int, default=8)
a = p.parse_args()
prepare(); CP = [s.strip().strip('"') for s in (ROOT / 'runtime/engine.args').read_text().splitlines()]; CP = CP[CP.index('-cp') + 1].split(';', 1)[1]
base = ROOT / 'runtime/search-bench'; base.mkdir(parents=True, exist_ok=True); out = pathlib.Path(tempfile.mkdtemp(prefix='compare-', dir=base))

def compile_engine(name, sources):
    classes = out / name / 'classes'; classes.mkdir(parents=True)
    args = out / name / 'compile.args'; args.write_text('\n'.join('"' + str(s).replace('\\', '/') + '"' for s in ['-encoding', 'UTF-8', '-nowarn', '-cp', CP, '-d', classes, *sources]))
    result = subprocess.run([str(JDK / 'bin/javac.exe'), '@' + str(args)], capture_output=True, text=True)
    if result.returncode: raise SystemExit(name + ' does not compile:\n' + result.stderr[-2000:])
    return classes
old_src = out / 'baseline' / 'src'; old_src.mkdir(parents=True)
for path in subprocess.run(['git', 'ls-tree', '--name-only', a.baseline, 'src/'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split():
    if path.endswith('.java'): (old_src / pathlib.Path(path).name).write_bytes(subprocess.run(['git', 'show', f'{a.baseline}:{path}'], cwd=ROOT, capture_output=True, check=True).stdout)
ENGINES = {'baseline': compile_engine('baseline', sorted(old_src.glob('*.java'))), 'current': compile_engine('current', sorted((ROOT / 'src').glob('*.java')))}

st = lambda key, radius, **kw: dict(kind='structure', key=key, radius=radius, **kw)
bi = lambda key, radius, **kw: dict(kind='biome', key=key, radius=radius, **kw)
alt = lambda kind, key: {'or': [dict(kind=kind, key=key)]}
fixed = dict(anchor='custom', x=0, z=0); spawn = dict(anchor='spawn')
# (name, seeds to check, request). "loose" marks a search the baseline itself does not repeat exactly (v0.1.31 builds
# fortresses on several workers at once, which the game does not allow for), so only seeds and positions are compared.
SEEDS = [
 ('structure: mansion r150 @0,0', 400000, dict(fixed, features=[st('woodland_mansions', 150)])),
 ('structure: mansion r500 @0,0', 150000, dict(fixed, features=[st('woodland_mansions', 500)])),
 ('structure: mansion r400 @-3000,7777', 150000, dict(anchor='custom', x=-3000, z=7777, features=[st('woodland_mansions', 400)])),
 ('structure: village r100 + mansion r600', 200000, dict(fixed, features=[st('villages', 100), st('woodland_mansions', 600)])),
 ('structure: ancient city r100 @0,0', 100000, dict(fixed, features=[st('ancient_cities', 100)])),
 ('structure: monument r150 @500,-800', 20000, dict(anchor='custom', x=500, z=-800, features=[st('ocean_monuments', 150)])),
 ('structure: village r200 @0,0', 5000, dict(fixed, features=[st('villages', 200)])),
 ('structure: 2 villages 100..600', 3000, dict(fixed, features=[st('villages', 600, minRadius=100, count=2)])),
 ('structure: village + mansion, no monument', 20000, dict(fixed, features=[st('villages', 300), st('woodland_mansions', 1500), st('ocean_monuments', 300, mode='exclude')])),
 ('structure: village or outpost r150', 5000, dict(fixed, features=[st('villages', 150, **alt('structure', 'pillager_outposts'))])),
 ('structure: plains village r250', 6000, dict(fixed, features=[st('villages__village_plains', 250)])),
 ('structure: fortress r150 (nether)', 4000, dict(fixed, features=[st('fortresses', 150)]), 'loose'),
 ('structure: stronghold r1400', 1500, dict(fixed, features=[st('strongholds', 1400)])),
 ('structure: village + spawn biome rule', 3000, dict(fixed, spawnBiomes=['plains', 'forest'], features=[st('villages', 300)])),
 ('structure: village + slime chunks', 5000, dict(fixed, slime=dict(radius=3, count=6), features=[st('villages', 300)])),
 ('structure: mansion r100 from spawn', 150000, dict(spawn, features=[st('woodland_mansions', 100)])),
 ('structure: village r200 from spawn', 3000, dict(spawn, features=[st('villages', 200)])),
 ('biome: mushroom r500 @0,0', 6000, dict(fixed, features=[bi('mushroom_fields', 500)])),
 ('biome: mushroom r150 from spawn', 6000, dict(spawn, features=[bi('mushroom_fields', 150)])),
 ('biome: cherry grove r300 from spawn', 6000, dict(spawn, features=[bi('cherry_grove', 300)])),
 ('biome: ice spikes 200..800 @5000,-9000', 4000, dict(anchor='custom', x=5000, z=-9000, features=[bi('ice_spikes', 800, minRadius=200)])),
 ('biome: badlands r400, fast mode', 6000, dict(fixed, biomeMode='fast', features=[bi('badlands', 400)])),
 ('biome: jungle r400, exhaustive mode', 300, dict(fixed, biomeMode='exhaustive', features=[bi('jungle', 400)])),
 ('biome: deep dark r300 (cave)', 3000, dict(fixed, features=[bi('deep_dark', 300)])),
 ('biome: lush caves r200 (cave)', 3000, dict(fixed, features=[bi('lush_caves', 200)])),
 ('biome: plains, no ocean within 300', 3000, dict(fixed, features=[bi('ocean', 300, mode='exclude'), bi('plains', 200)])),
 ('biome: pale garden or dark forest r250', 4000, dict(fixed, features=[bi('pale_garden', 250, **alt('biome', 'dark_forest'))])),
 ('biome: village r400 with desert near it', 3000, dict(fixed, features=[st('villages', 400, id='a'), bi('desert', 150, near='a')])),
 ('biome: meadow + cherry grove + mansion', 20000, dict(fixed, features=[bi('meadow', 300), bi('cherry_grove', 400), st('woodland_mansions', 1000)])),
]
# Searches inside one seed: (name, seed, blocks from the origin, conditions).
WORLDS = [
 ('inside a seed: mushroom fields', '123', 24000, [bi('mushroom_fields', 500)]),
 ('inside a seed: ice spikes', '-77', 16000, [bi('ice_spikes', 500)]),
 ('inside a seed: mansion with cherry grove near', '2024', 40000, [st('woodland_mansions', 500), bi('cherry_grove', 600)]),
]
wanted = lambda name: not a.only or any(o in name for o in a.only)

def run(classes):
    home = classes.parent / 'run'; home.mkdir()
    (home / 'engine.args').write_text('\n'.join('"' + s + '"' for s in ['-Xmx6g', '-cp', classes.as_posix() + ';' + CP, 'SeedEngine']))
    proc = subprocess.Popen([str(JDK / 'bin/java.exe'), '@' + str(home / 'engine.args')], cwd=home, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(home / 'stderr.log').open('w'), text=True, encoding='utf-8')
    def event():
        while True:
            line = proc.stdout.readline()
            if not line: raise RuntimeError('The engine stopped; see ' + str(home / 'stderr.log'))
            if line.startswith('SEEDSCOUT '): return json.loads(line[10:])
    def send(o): proc.stdin.write(json.dumps(o) + '\n'); proc.stdin.flush()
    while event()['type'] != 'ready': pass
    results = {}; job = 0
    for name, limit, request, *_ in SEEDS:
        if not wanted(name): continue
        job += 1; send(dict(cmd='start', id=job, seed='-3811937398911544709', threads=a.threads, limit=limit, maxMatches=10**9, **request)); found = []
        while True:
            e = event()
            if e['type'] == 'error': raise RuntimeError(name + ': ' + str(e))
            if e.get('id') != job: continue
            if e['type'] == 'match': found.append(e['data'])
            if e['type'] == 'progress' and not e['running']:
                assert not e['error'] and e['tested'] == limit, e
                results[name] = (sorted(found, key=lambda m: int(m['seed'])), e['seconds']); break
    for name, seed, reach, features in WORLDS:
        if not wanted(name): continue
        job += 1; send(dict(cmd='world', id=job, seed=seed, threads=a.threads, maxMatches=10**9, range=reach, features=features)); found = []
        while True:
            e = event()
            if e['type'] == 'error': raise RuntimeError(name + ': ' + str(e))
            if e.get('id') != job: continue
            if e['type'] == 'place': found.append(e['data'])
            if e['type'] == 'worldprogress' and not e['running']:
                assert not e['error'] and e['complete'], e
                results[name] = (sorted(found, key=lambda m: (m['x'], m['z'])), e['seconds']); break
    proc.stdin.close(); proc.wait(timeout=60); return results

def loosely(matches): return [(m['seed'], [(f['key'], f['x'], f['z']) for f in m['features']]) for m in matches]
old, new = run(ENGINES['baseline']), run(ENGINES['current']); different = 0
print(f'{"":10s}{"search":45s}{"checked":>9s}{"matches":>9s}{a.baseline:>12s}{"current":>12s}')
for name, limit, _, *flags in SEEDS + [(n, None, None) for n, *_ in WORLDS]:
    if name not in old: continue
    (x, xs), (y, ys) = old[name], new[name]
    same = (loosely(x) == loosely(y)) if flags else json.dumps(x, sort_keys=True) == json.dumps(y, sort_keys=True); different += not same
    speed = (f'{limit/xs:>10,.0f}/s{limit/ys:>10,.0f}/s' if limit else f'{xs:>10.1f} s {ys:>10.1f} s ') + f'{xs/ys:>7.1f}x'
    print(f'{"same" if same else "DIFFERENT":10s}{name:45s}{limit or "":>9}{len(x):>9d}{speed}' + ('   (seeds and positions only)' if flags else ''), flush=True)
print('Every search gave the same matches.' if not different else f'{different} searches gave different matches.'); print('Artifacts:', out)
raise SystemExit(1 if different else 0)
