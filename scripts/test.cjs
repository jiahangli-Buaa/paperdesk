const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const local=path.join(root,'build/runtime',process.platform==='darwin'?'macos-arm64/python/bin/python3':'windows-x64/python/python.exe');
const python=fs.existsSync(local)?local:process.platform==='win32'?'python':'python3';
const backend=path.join(root,'src/backend'),tests=path.join(root,'tests/backend');
const code='import sys,unittest; sys.path[:0]=sys.argv[1:3]; suite=unittest.defaultTestLoader.discover(sys.argv[2]); result=unittest.TextTestRunner(verbosity=1).run(suite); sys.exit(not result.wasSuccessful())';
const result=spawnSync(python,['-B','-c',code,backend,tests],{cwd:root,stdio:'inherit',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONTZPATH:path.join(root,'build/runtime',process.platform==='darwin'?'macos-arm64':'windows-x64','tzdata/zoneinfo')}});
if(result.status)process.exit(result.status);
for(const file of fs.readdirSync(path.join(root,'tests/desktop')).filter(n=>/^test_.*\.(mjs|cjs)$/.test(n))){
 const r=spawnSync(process.execPath,[path.join(root,'tests/desktop',file)],{cwd:root,stdio:'inherit'});if(r.status)process.exit(r.status);
}
