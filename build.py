"""Compile against the user's installed snapshot; no Minecraft files are distributed."""
import json, os, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parent
# A checkout keeps everything in its own folder and uses this machine's tools. The desktop app sets these instead:
# its data lives outside the install folder (which an update replaces) and it brings its own Java.
DATA = pathlib.Path(os.environ.get('SEED_SCOUT_DATA') or ROOT)
GAME_HOME = pathlib.Path(os.environ.get('SEED_SCOUT_MINECRAFT') or pathlib.Path(os.environ['APPDATA']) / '.minecraft')
# The version the engine was written against. Others work when their world-generation classes still match.
DEFAULT_VERSION = '26.4-snapshot-2'
JDK = pathlib.Path(os.environ.get('SEED_SCOUT_JDK') or ROOT.parent / '.tools/jdk-25.0.4.1+1')
def engine_memory():
    """Half of this machine's memory for the engine, between 2 and 6 GB."""
    try:
        import ctypes
        class Status(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in ('total', 'available', 'totalPage', 'availablePage', 'totalVirtual', 'availableVirtual', 'extended')]
        status = Status(); status.length = ctypes.sizeof(Status)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        return max(2, min(6, status.total // (2 << 30)))
    except (AttributeError, OSError): return 6
def installed_versions():
    """Vanilla versions the launcher has downloaded, newest first. Modded profiles, which inherit from one, are left out."""
    found = []
    for folder in (GAME_HOME / 'versions').glob('*'):
        meta = folder / f'{folder.name}.json'
        if not meta.exists() or not (folder / f'{folder.name}.jar').exists(): continue
        try: data = json.loads(meta.read_text(encoding='utf-8'))
        except (OSError, ValueError): continue
        if data.get('inheritsFrom'): continue
        found.append({'id': folder.name, 'type': data.get('type', ''), 'released': data.get('releaseTime', '')})
    return sorted(found, key=lambda v: v['released'], reverse=True)
def chosen_version():
    """SEED_SCOUT_VERSION, else the version picked in the app, else the one the engine was written against, else the newest installed."""
    try: saved = json.loads((DATA / 'settings.json').read_text(encoding='utf-8')).get('version')
    except (OSError, ValueError): saved = None
    installed = [v['id'] for v in installed_versions()]
    for version in (os.environ.get('SEED_SCOUT_VERSION'), saved, DEFAULT_VERSION):
        if version in installed: return version
    return installed[0] if installed else DEFAULT_VERSION
def prepare(version=None):
    version = version or chosen_version()
    version_dir = GAME_HOME / 'versions' / version
    if not (JDK / 'bin/javac.exe').exists(): raise RuntimeError(f'Java was not found in {JDK}. Reinstall Seed Scout, or set SEED_SCOUT_JDK to a JDK 25 folder.')
    if not (version_dir / f'{version}.json').exists(): raise RuntimeError(f'Minecraft {version} is not installed in {GAME_HOME}. Install it in the Minecraft Launcher and start it once, or choose another Minecraft folder.')
    metadata = json.loads((version_dir / f'{version}.json').read_text(encoding='utf-8'))
    game = version_dir / f'{version}.jar'
    def allowed(lib):
        rules=lib.get('rules',[])
        result=not rules
        for rule in rules:
            operating=rule.get('os',{})
            if operating.get('name','windows') == 'windows' and operating.get('arch','x86_64') in ('x86_64','amd64'):
                result=rule['action']=='allow'
        return result
    libraries = [GAME_HOME / 'libraries' / lib['downloads']['artifact']['path']
                 for lib in metadata['libraries'] if allowed(lib) and 'artifact' in lib.get('downloads', {})]
    missing = [str(p) for p in [game, *libraries] if not p.exists()]
    if missing: raise RuntimeError(f'Minecraft {version} is only partly downloaded: {len(missing)} of its files are missing (the first: {pathlib.Path(missing[0]).name}). Start that version once in the Minecraft Launcher so it finishes downloading, then open Seed Scout again.')
    output = DATA / 'runtime/classes'; output.mkdir(parents=True, exist_ok=True)
    cp = os.pathsep.join(map(str, [output, game, *libraries]))
    args = ['-encoding', 'UTF-8', '-cp', cp, '-d', str(output), *map(str, (ROOT/'src').glob('*.java'))]
    # A version whose classes differ fails here, before anything of the working engine is replaced.
    attempt = DATA / 'runtime/compile.attempt.args'
    attempt.write_text('\n'.join('"' + s.replace('\\', '/') + '"' for s in args), encoding='utf-8')
    result = subprocess.run([str(JDK/'bin/javac.exe'), '@'+str(attempt)], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        errors = [line for line in (result.stderr + result.stdout).splitlines() if ' error: ' in line]
        first = errors[0].split(' error: ', 1)[1] if errors else (result.stderr.strip().splitlines() or ['javac failed'])[-1]
        raise RuntimeError(f'Seed Scout does not support Minecraft {version} yet: its world generation code differs from {DEFAULT_VERSION}. Use {DEFAULT_VERSION}, or another version listed at the top of the app. (Technical detail: {len(errors)} compile errors, the first: {first})')
    os.replace(attempt, DATA / 'runtime/compile.args')
    runargs = DATA / 'runtime/engine.args'
    runargs.write_text('\n'.join('"'+s.replace('\\','/')+'"' for s in [f'-Xmx{engine_memory()}g','-cp',cp,'SeedEngine']), encoding='utf-8')
    return [str(JDK/'bin/java.exe'), '@'+str(runargs)]
if __name__ == '__main__': print(' '.join(prepare()))
