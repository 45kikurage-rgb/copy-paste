import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('// ===== 商品名・容量の簡易確認 ====='),html.indexOf('// ===== 計算表 ====='));
const parsers=html.slice(html.indexOf('function normalizeMarkdownUrls('),html.indexOf('function format(){'));
const sbg=n=>'https://sbg.jp/cp/exchange/888/'+n.toString(16).padStart(32,'0');
const petit='https://coupon.petit.gift/coupons/detail?'+new URLSearchParams({
  app_id:'1',coupon_id:'1406',user_id:'00000000-0000-0000-0000-000000000000',enc:'$2y$10$'+'a'.repeat(53),t:'20261107103425',
});
function setup(respond){
  const nodes=new Map(),calls=[],delays=[];
  const node=()=>({value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,style:{},children:[],
    classList:{add(){},remove(){},contains(){return false;}},setAttribute(){},addEventListener(){},
    appendChild(child){this.children.push(child);}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const input={value:''};
  const context=vm.createContext({input,URL,performance:{now:()=>1000},TypeError,
    document:{getElementById:get,createElement:node,addEventListener(){}},window:{open(){}},
    setTimeout(fn,ms){delays.push(ms);fn();},
    fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return respond(body,calls.length);},
  });
  vm.runInContext(parsers+source,context);
  const app=vm.runInContext('({getCouponItems,runCouponCheck,renderCouponResults})',context);
  return {get,input,calls,delays,...app};
}
const ok=body=>({ok:true,status:200,json:async()=>({results:body.items.map(item=>({...item,product:'500円ギフト券',size:'none',status:'ok',merchant:'サーティワンアイスクリーム',attempt:6}))})});
test('SB Gift and Petit Gift are accepted with numbers, duplicates removed, invalid hosts rejected',()=>{
  const app=setup(ok);
  app.input.value='17\n'+sbg(1)+'\n18\t\t'+petit+'\n19\n'+sbg(1)+'\n20\n'+sbg(2).replace('sbg.jp','sbg.jp.evil.test');
  const items=app.getCouponItems();
  assert.deepEqual(Array.from(items,x=>x.label),['17','18']);
  assert.deepEqual(Array.from(items,x=>x.url),[sbg(1),petit]);
});
test('accepts every shared API provider and rejects credentials, bad paths and duplicate parameters',()=>{
  const app=setup(ok);
  const good=[
    'https://coupon.sej.co.jp/order/cpnsp_03.do?hansoku_id=synthetic123',
    'https://ncpfa.famima.com/prd/ebcweb?eKey=synthetic123&cpNo=092&gyNo=00',
    sbg(1),petit,
    'https://apli.lawson.jp/ldcp/coupon/?campaignId=fixture&encDataCode=VEVTVEZJWFRVUkU%3D',
    'https://g4b.giftee.biz/giftee_boxes/00000000-0000-4000-8000-000000000000/home',
    'https://misterdonut.e-gift.co/c/fixture123/1',
    'https://gift.starbucks.co.jp/e/fixture123',
  ];
  app.input.value=good.join('\n');
  assert.equal(app.getCouponItems().length,8);
  app.input.value=[sbg(1).replace('https:','http:'),sbg(1).replace('sbg.jp','user:pass@sbg.jp'),sbg(1)+'?redeem=1',petit+'&coupon_id=2'].join('\n');
  assert.equal(app.getCouponItems().length,0);
});
test('2000 numbered URLs finish in 20 bounded requests and preserve the pasted text',async()=>{
  const app=setup(ok),input=Array.from({length:2000},(_,i)=>(i+1)+'\t\t'+sbg(i+1)).join('\n');
  app.input.value=input;await app.runCouponCheck();
  assert.equal(app.calls.length,20);
  assert.ok(app.calls.every(c=>c.items.length===100));
  assert.deepEqual(app.calls.flatMap(c=>c.items.map(x=>x.label)),Array.from({length:2000},(_,i)=>String(i+1)));
  assert.equal(app.input.value,input);
  assert.equal(app.get('couponResultTotal').textContent,'URL合計 2000件');
  assert.equal(app.get('couponCheckClose').disabled,false);
});
test('2001 URLs are rejected before any network request',async()=>{
  const app=setup(ok);app.input.value=Array.from({length:2001},(_,i)=>sbg(i+1)).join('\n');
  await app.runCouponCheck();
  assert.equal(app.calls.length,0);assert.match(app.get('couponCheckError').textContent,/2,000件/);
});
test('does not multiply the shared API per-URL retries after a valid response',async()=>{
  const app=setup(body=>({ok:true,status:200,json:async()=>({results:body.items.map(item=>({...item,product:'商品名不明',size:'unknown',status:'error',attempt:6}))})}));
  app.input.value=sbg(1);await app.runCouponCheck();
  assert.equal(app.calls.length,1);
  assert.match(app.get('couponResultNote').textContent,/最大5回/);
});
test('network retries recover on sixth request and do not resend successful batches',async()=>{
  const app=setup((body,n)=>n===1||n===7?ok(body):({ok:false,status:503,json:async()=>({error:'temporary'})}));
  app.input.value=Array.from({length:134},(_,i)=>sbg(i+1)).join('\n');
  await app.runCouponCheck();
  assert.equal(app.calls.length,7);assert.equal(app.calls[0].items.length,100);
  assert.ok(app.calls.slice(1).every(c=>c.items.length===34));
  assert.deepEqual(app.delays,[1500,4000,4000,4000,4000]);
  assert.match(app.get('couponResultNote').textContent,/すべて/);
});
test('exhausted network retries retain failed URLs and continue later batches',async()=>{
  const app=setup((body,n)=>n<=6?{ok:false,status:503,json:async()=>({error:'temporary'})}:ok(body));
  app.input.value=Array.from({length:134},(_,i)=>sbg(i+1)).join('\n');await app.runCouponCheck();
  assert.equal(app.calls.length,7);assert.equal(app.get('couponResultTotal').textContent,'URL合計 134件');
  assert.match(app.get('couponResultNote').textContent,/100件/);
});
test('same product at different merchants is displayed as separate groups',()=>{
  const app=setup(ok);
  app.renderCouponResults([{product:'500円ギフト券',size:'none',status:'ok',merchant:'店舗A'},{product:'500円ギフト券',size:'none',status:'ok',merchant:'店舗B'}],0);
  const rows=app.get('couponResultRows').children;assert.equal(rows.length,2);
  assert.ok(rows[0].children[0].textContent.includes('店舗A'));
  assert.ok(rows[1].children[0].textContent.includes('店舗B'));
});

