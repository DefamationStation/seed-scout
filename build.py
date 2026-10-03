"""Compile against the user's installed snapshot; no Minecraft files are distributed."""
import json, os, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parent
GAME_HOME = pathlib.Path(os.environ['APPDATA']) / '.minecraft'
VERSION = '26.4-snapshot-2'
JDK = ROOT.parent / '.tools/jdk-25.0.4.1+1'
def prepare():
    version_dir = GAME_HOME / 'versions' / VERSION
    metadata = json.loads((version_dir / f'{VERSION}.json').read_text())
    game = version_dir / f'{VERSION}.jar'
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
    if missing: raise RuntimeError('Missing installed Minecraft libraries: ' + ', '.join(missing[:3]))
    output = ROOT / 'runtime/classes'; output.mkdir(parents=True, exist_ok=True)
    cp = os.pathsep.join(map(str, [output, game, *libraries]))
    args = ['-encoding', 'UTF-8', '-cp', cp, '-d', str(output), *map(str, (ROOT/'src').glob('*.java'))]
    argfile = ROOT / 'runtime/compile.args'
    argfile.write_text('\n'.join('"' + s.replace('\\', '/') + '"' for s in args), encoding='utf-8')
    subprocess.run([str(JDK/'bin/javac.exe'), '@'+str(argfile)], check=True, cwd=ROOT)
    runargs = ROOT / 'runtime/engine.args'
    runargs.write_text('\n'.join('"'+s.replace('\\','/')+'"' for s in ['-Xmx6g','-cp',cp,'SeedEngine']), encoding='utf-8')
    return [str(JDK/'bin/java.exe'), '@'+str(runargs)]
if __name__ == '__main__': print(' '.join(prepare()))
