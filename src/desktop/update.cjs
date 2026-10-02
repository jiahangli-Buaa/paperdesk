function compareVersions(left, right) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error('版本格式无效');
    return {numbers: [Number(match[1]),Number(match[2]),Number(match[3]||0)]};
  };
  const a = parse(left), b = parse(right);
  for (let i=0;i<3;i++) if(a.numbers[i]!==b.numbers[i]) return Math.sign(a.numbers[i]-b.numbers[i]);
  return 0;
}
function releaseFor(manifest, platform, version) {
  if(manifest.format!=='paperdesk-updates-v1' || typeof manifest.version!=='string') throw new Error('更新信息格式无效');
  const newer=compareVersions(manifest.version,version)>0;
  const url=manifest.downloads?.[platform];
  if(newer && (!url || new URL(url).protocol!=='https:')) throw new Error('更新下载地址无效');
  return {newer, version:manifest.version, url, notes:String(manifest.notes||'').slice(0,3000)};
}
function displayVersion(version){return version.replace(/^(\d+\.\d+)\.0$/,'$1');}
module.exports={compareVersions,releaseFor,displayVersion};
