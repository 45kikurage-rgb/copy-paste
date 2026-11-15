import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('// ===== 商品名・容量の簡易確認 ====='),html.indexOf('// ===== 計算表 ====='));
const parsers=html.slice(html.indexOf('function normalizeMarkdownUrls('),html.indexOf('function format(){'));
const sbg=n=>'https://sbg.jp/cp/exchange/888/'+n.toString(16).padStart(32,'0');
const fixture=count=>Array.from({length:count},(_,i)=>`${i+1}\n\n${sbg(i+1)}`).join('\n\n');

function setup({clipboardError=false,fallbackSuccess=true,deferClipboard=false,deferFetch=false}={}){
  const nodes=new Map(),writes=[],commands=[],timers=[],clipboardPending=[],fetchPending=[];
  let activeElement=null;
  const createNode=tag=>{
    const listeners=new Map(),attrs=new Map(),classes=new Set();
    let text='',markup='';
    const node={tagName:String(tag||'div').toUpperCase(),value:'',hidden:false,disabled:false,style:{},dataset:{},children:[],
      className:'',selectionStart:0,selectionEnd:0,
      classList:{add(...values){values.forEach(value=>classes.add(value));},remove(...values){values.forEach(value=>classes.delete(value));},contains(value){return classes.has(value);},toggle(value,force){const next=force??!classes.has(value);if(next)classes.add(value);else classes.delete(value);return next;}},
      setAttribute(key,value){attrs.set(key,String(value));},getAttribute(key){return attrs.get(key)??null;},removeAttribute(key){attrs.delete(key);},
      addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
      async dispatch(type){for(const fn of listeners.get(type)||[])await fn({type,target:node,currentTarget:node,preventDefault(){}});},
      appendChild(child){this.children.push(child);child.parentNode=this;return child;},
      append(...children){children.forEach(child=>this.appendChild(child));},
      replaceChildren(...children){this.children=[];this.append(...children);},
      remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);},
      focus(){activeElement=this;},select(){activeElement=this;this.selectionStart=0;this.selectionEnd=this.value.length;},
      setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
      querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='button'&&child.tagName==='BUTTON'?[child]:[]),...child.querySelectorAll(selector)]);},
    };
    Object.defineProperties(node,{
      textContent:{get(){return text;},set(value){text=String(value);node.children=[];}},
      innerHTML:{get(){return markup;},set(value){markup=String(value);node.children=[];}},
    });
    return node;
  };
  const get=id=>{if(!nodes.has(id))nodes.set(id,createNode('div'));return nodes.get(id);};
  const input=createNode('textarea'),output=createNode('textarea'),body=createNode('body');
  const document={getElementById:get,createElement:createNode,createDocumentFragment:()=>createNode('fragment'),body,addEventListener(){},
    get activeElement(){return activeElement;},execCommand(command){commands.push({command,value:activeElement?.value});return fallbackSuccess;}};
  const context=vm.createContext({input,output,URL,performance:{now:()=>1000},TypeError,document,
    navigator:{clipboard:{writeText:async value=>{if(clipboardError)throw new Error('Clipboard blocked');if(deferClipboard)await new Promise((resolve,reject)=>clipboardPending.push(Object.assign(resolve,{reject})));writes.push(value);}}},
    window:{open(){},isSecureContext:true},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},
    fetch:async(url,options)=>{const body=JSON.parse(options.body);if(deferFetch)await new Promise(resolve=>fetchPending.push(resolve));return {ok:true,status:200,json:async()=>({results:body.items.map(item=>({...item,product:'テスト商品',size:'350',status:'ok'}))})};},
  });
  vm.runInContext(parsers+source,context);
  const run=expression=>vm.runInContext(expression,context);
  const setInput=value=>{input.value=value;output.value=value;};
  return {get,input,output,writes,commands,timers,clipboardPending,fetchPending,run,setInput,context};
}

function rangeButtons(app){return app.get('couponCopyButtons').children;}
function labels(app){return rangeButtons(app).map(button=>button.textContent);}
async function prepare(app,count=24){
  app.setInput(fixture(count));
  app.get('couponCopyCount').value='5';
  await app.run('runCouponCheck()');
}

test('24 URLs create exact five-item ranges, then changing to eight replaces the buttons',async()=>{
  const app=setup();await prepare(app);
  assert.deepEqual(labels(app),['1–5','6–10','11–15','16–20','21–24']);
  app.get('couponCopyCount').value='8';await app.get('couponCopyCount').dispatch('input');
  assert.deepEqual(labels(app),['1–8','9–16','17–24']);
  assert.equal(rangeButtons(app).length,3);
});

test('range copy preserves number/URL blank lines and copies the final partial group only',async()=>{
  const app=setup();await prepare(app);
  await rangeButtons(app)[0].dispatch('click');
  assert.equal(app.writes[0],fixture(5));
  await rangeButtons(app)[4].dispatch('click');
  assert.equal(app.writes[1],Array.from({length:4},(_,i)=>`${i+21}\n\n${sbg(i+21)}`).join('\n\n'));
});

test('copy preserves supplied serial numbers, ordering and repeated URLs',async()=>{
  const app=setup();
  app.setInput(`17\n\n${sbg(3)}\n\n4\n\n${sbg(1)}\n\n99\n\n${sbg(3)}`);
  app.get('couponCopyCount').value='2';await app.run('runCouponCheck()');
  await rangeButtons(app)[0].dispatch('click');
  assert.equal(app.writes[0],`17\n\n${sbg(3)}\n\n4\n\n${sbg(1)}`);
  await rangeButtons(app)[1].dispatch('click');
  assert.equal(app.writes[1],`99\n\n${sbg(3)}`);
});

test('mixed input spacing is copied in the established blank-line format without renumbering',async()=>{
  const app=setup();
  app.setInput(`001\t\t${sbg(1)}\r\n19\r\n${sbg(2)}`);
  app.get('couponCopyCount').value='5';await app.run('runCouponCheck()');
  await rangeButtons(app)[0].dispatch('click');
  assert.equal(app.writes[0],`001\n\n${sbg(1)}\n\n19\n\n${sbg(2)}`);
});

test('invalid copy counts clear old range buttons',async()=>{
  const app=setup();await prepare(app);
  for(const value of ['','0','-1','1.5','1e2','abc']){
    app.get('couponCopyCount').value=value;await app.get('couponCopyCount').dispatch('input');
    assert.equal(rangeButtons(app).length,0,`invalid count ${JSON.stringify(value)}`);
  }
});

test('full-width digits also update the editable copy count',async()=>{
  const app=setup();await prepare(app);
  app.get('couponCopyCount').value='８';await app.get('couponCopyCount').dispatch('input');
  assert.deepEqual(labels(app),['1–8','9–16','17–24']);
});

test('formatted URL pairs outside the analyzer provider list remain copyable',async()=>{
  const app=setup();
  const value=`9\n\nhttps://example.test/user-link\n\n11\n\n${sbg(1)}`;
  app.setInput(value);app.get('couponCopyCount').value='2';await app.run('runCouponCheck()');
  await rangeButtons(app)[0].dispatch('click');assert.equal(app.writes[0],value);
});

test('copy count greater than URL count creates one complete range',async()=>{
  const app=setup();await prepare(app);
  app.get('couponCopyCount').value='100';await app.get('couponCopyCount').dispatch('input');
  assert.deepEqual(labels(app),['1–24']);
  await rangeButtons(app)[0].dispatch('click');assert.equal(app.writes[0],fixture(24));
});

test('a failed Clipboard API uses a successful copy fallback',async()=>{
  const app=setup({clipboardError:true});await prepare(app);
  await rangeButtons(app)[0].dispatch('click');
  assert.equal(app.commands.length,1);assert.equal(app.commands[0].command,'copy');
  assert.equal(app.commands[0].value,fixture(5));
});

test('copy failure is reported without marking the range as copied',async()=>{
  const app=setup({clipboardError:true,fallbackSuccess:false});await prepare(app);
  await rangeButtons(app)[0].dispatch('click');
  assert.match(app.get('couponCopyStatus').textContent,/失敗|できません/);
  assert.doesNotMatch(app.get('couponCopyStatus').textContent,/コピーしました|コピー済み/);
});

test('reanalysis replaces copy ranges and invalid/empty input removes previous ranges',async()=>{
  const app=setup();await prepare(app);
  app.setInput(fixture(3));await app.run('runCouponCheck()');
  assert.deepEqual(labels(app),['1–3']);
  app.setInput('');await app.run('runCouponCheck()');
  assert.equal(rangeButtons(app).length,0);
});

test('editing pasted input invalidates ranges from the previous analysis immediately',async()=>{
  const app=setup();await prepare(app);
  app.input.value=fixture(2);await app.input.dispatch('input');
  assert.equal(rangeButtons(app).length,0);
  assert.equal(app.get('couponCopyPanel').hidden,true);
});

test('a pending copy does not mark regenerated ranges as copied',async()=>{
  const app=setup({deferClipboard:true});await prepare(app);
  const previousButton=rangeButtons(app)[0],copying=previousButton.dispatch('click');
  app.get('couponCopyCount').value='8';await app.get('couponCopyCount').dispatch('input');
  app.clipboardPending.shift()();await copying;
  assert.deepEqual(labels(app),['1–8','9–16','17–24']);
  assert.equal(app.get('couponCopyStatus').textContent,'');
  assert.ok(rangeButtons(app).every(button=>!button.classList.contains('is-copied')));
});

test('a rejected pending copy never invokes the fallback for an obsolete range',async()=>{
  const app=setup({deferClipboard:true});await prepare(app);
  const copying=rangeButtons(app)[0].dispatch('click');
  app.get('couponCopyCount').value='8';await app.get('couponCopyCount').dispatch('input');
  app.clipboardPending.shift().reject(new Error('Clipboard blocked'));await copying;
  assert.equal(app.commands.length,0);
  assert.equal(app.get('couponCopyStatus').textContent,'');
});

test('editing input while analysis is pending never restores stale copy ranges',async()=>{
  const app=setup({deferFetch:true});
  app.setInput(fixture(24));app.get('couponCopyCount').value='5';
  const checking=app.run('runCouponCheck()');
  app.input.value=fixture(3);await app.input.dispatch('input');
  app.fetchPending.shift()();await checking;
  assert.equal(rangeButtons(app).length,0);
  assert.equal(app.get('couponCopyPanel').hidden,true);
});

test('2000 URLs partition without lost or repeated items',async()=>{
  const app=setup();await prepare(app,2000);
  app.get('couponCopyCount').value='333';await app.get('couponCopyCount').dispatch('input');
  assert.deepEqual(labels(app),['1–333','334–666','667–999','1000–1332','1333–1665','1666–1998','1999–2000']);
  for(const button of rangeButtons(app))await button.dispatch('click');
  assert.equal(app.writes.join('\n\n'),fixture(2000));
});
