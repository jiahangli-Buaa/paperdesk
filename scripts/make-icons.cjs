const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {Resvg}=require('@resvg/resvg-js');
const root=path.resolve(__dirname,'..'),assets=path.join(root,'assets');
const svg=fs.readFileSync(path.join(assets,'icon.svg'));
function png(source,width){return new Resvg(source,{fitTo:{mode:'width',value:width}}).render().asPng();}
fs.writeFileSync(path.join(assets,'icon.png'),png(svg,1024));
fs.writeFileSync(path.join(assets,'trayTemplate.png'),png(fs.readFileSync(path.join(assets,'tray.svg')),40));
const icon=png(svg,256),head=Buffer.alloc(22);head.writeUInt16LE(1,2);head.writeUInt16LE(1,4);head[6]=0;head[7]=0;head.writeUInt16LE(1,10);head.writeUInt16LE(32,12);head.writeUInt32LE(icon.length,14);head.writeUInt32LE(22,18);
fs.writeFileSync(path.join(assets,'icon.ico'),Buffer.concat([head,icon]));
if(process.platform==='darwin'){
 const folder=path.join(root,'build/work/icon.iconset');fs.mkdirSync(folder,{recursive:true});
 for(const size of [16,32,128,256,512])for(const scale of [1,2])fs.writeFileSync(path.join(folder,`icon_${size}x${size}${scale===2?'@2x':''}.png`),png(svg,size*scale));
 const result=spawnSync('iconutil',['-c','icns',folder,'-o',path.join(assets,'icon.icns')],{stdio:'inherit'});if(result.status)process.exit(result.status);
}
