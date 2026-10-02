import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../src/ui/app.js',import.meta.url),'utf8');
const elements=new Map();
const element=key=>{
 if(!elements.has(key))elements.set(key,{open:false,innerHTML:'',style:{setProperty(){}},getAttribute(){return null;},removeAttribute(){},showModal(){this.open=true;},close(){this.open=false;},addEventListener(){},classList:{add(){},remove(){},toggle(){}}});
 return elements.get(key);
};
const displayed=[],instances=[],claims=new Set(),requests=[];
class FakeNotification {
 static permission='default';
 constructor(title,options){displayed.push({title,...options});instances.push(this);}
 close(){}
}
const state={journals:[],accounts:[],events:[],manuscripts:[{id:'paper',title_en:'Test notification',status:'review',unread_changes:[],deadline_alerts:[]}],
 token:'fresh-process-token',auto_refresh:{},notification_settings:{status_desktop:true,deadline_desktop:false,deadline_reminders:true},
 notifications:[{id:'event:test',kind:'status',manuscript_id:'paper',old_label:'已投稿',new_label:'审稿中'}]};
const context=vm.createContext({console,URL,Date,Intl,Set,Map,Notification:FakeNotification,
 window:{Notification:FakeNotification,focus(){}},localStorage:{getItem(){return null;},setItem(){}},
 document:{body:element('body'),querySelector:element,querySelectorAll(){return [];},addEventListener(){},hidden:false},
 setTimeout(){},clearTimeout(){},setInterval(){},
 fetch:async(path,options)=>{
  if(path==='/api/state')return {ok:true,json:async()=>structuredClone(state)};
  requests.push({path,...options});
  const ids=JSON.parse(options.body).ids.filter(id=>!claims.has(id));
  ids.forEach(id=>claims.add(id));
  return {ok:true,json:async()=>({ok:true,ids})};
 }
});
vm.runInContext(source,context);
await new Promise(setImmediate);
assert.equal(displayed.length,0,'No desktop prompt or notification without granted permission');
FakeNotification.permission='granted';
await vm.runInContext('deliverDesktop(live)',context);
assert.equal(displayed.length,1);
assert.match(displayed[0].body,/已投稿 → 审稿中/);
assert.equal(requests[0].headers['X-Paperdesk-Token'],'fresh-process-token');
await vm.runInContext('deliverDesktop(live)',context);
assert.equal(displayed.length,1,'Already claimed notices do not display twice');
state.manuscripts[0].title_en='Fresh state after notification click';
await instances[0].onclick();
assert.match(element('#drawer').innerHTML,/Fresh state after notification click/);
FakeNotification.permission='denied';
await vm.runInContext('deliverDesktop(live)',context);
assert.equal(displayed.length,1);
element('#drawer').open=false;
state.manuscripts[0].title_en='Completed account during ongoing refresh';
await vm.runInContext('refreshing=true; pollBackgroundState()',context);
assert.equal(vm.runInContext('live.manuscripts[0].title_en',context),state.manuscripts[0].title_en);
assert.match(element('#app').innerHTML,/正在读取/,'Refreshing stays visible while completed account data is shown');
element('#modal').open=true;
state.manuscripts[0].title_en='Keep the editing form intact';
await vm.runInContext('pollBackgroundState()',context);
assert.equal(vm.runInContext('live.manuscripts[0].title_en',context),'Completed account during ongoing refresh');
element('#modal').open=false;
console.log('PASS: notification permission, delivery content, current token, duplicate suppression');
