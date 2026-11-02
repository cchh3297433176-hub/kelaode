const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright' : 'playwright');
const fs = require('fs');
const assert = require('assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.WBR_BROWSER_PATH || undefined, args:['--no-sandbox', '--disable-dev-shm-usage']});
 const page = await browser.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:1 });
 const errors=[]; page.on('console',msg=>{if(msg.type()==='error') console.log('BROWSER ERROR',msg.text())}); page.on('pageerror', e=>errors.push(e.message));
 const root=require('path').resolve(__dirname,'..')+'/';
 const prefix='/scripts/extensions/third-party/kelaode/';
 const mocks={
 '/scripts/extensions.js':`export const extension_settings=window.fixture.settings; export const getContext=()=>window.fixture.context;`,
 '/script.js':`export const event_types={CHAT_CHANGED:'chat',WORLDINFO_SETTINGS_UPDATED:'world',WORLDINFO_UPDATED:'updated',GENERATION_AFTER_COMMANDS:'generation'}; export const eventSource={on:(name,fn)=>(window.fixture.events[name]??=[]).push(fn)}; export function updateMessageBlock(){}`,
 '/scripts/power-user.js':`export const power_user={};`,
 '/scripts/extensions/regex/engine.js':`export const getRegexScripts=()=>window.fixture.settings.regex;`,
 [prefix+'api.js']:`export const API={getAllBookNames:async()=>Object.keys(window.fixture.books),getGlobalBindings:async()=>window.fixture.active,getCharBindings:async()=>({primary:window.fixture.primary||null,additional:[]}),getChatBinding:async()=>null};`,
 [prefix+'actions.js']:`import {STATE} from './state.js'; export const Actions={flushPendingSave:async()=>{},applyTheme:()=>{},switchView:()=>{},getTokenCount:()=>0,refreshAllContext:async()=>{STATE.allBookNames=Object.keys(fixture.books);STATE.bindings={char:{primary:null,additional:[]},global:fixture.active,chat:null}},loadBook:async name=>{STATE.currentBookName=name;const {UI}=await import('./ui.js');UI.renderBookSelector();UI.renderList();await UI.renderRegexEditor();}};`,
 };
 await page.route('http://wbr.test/**', async route=>{
   const path=new URL(route.request().url()).pathname;
   if(mocks[path]) return route.fulfill({contentType:'text/javascript',body:mocks[path]});
   if(path.startsWith(prefix)) {
    const file=root+path.slice(prefix.length);
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
   }
   await route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css"><style>body{background:#f7f5f2;color:#333;font-family:sans-serif;padding:14px;--SmartThemeBodyColor:#333;--SmartThemeBlurTintColor:#fff;--SmartThemeBorderColor:#ddd} .menu_button{padding:7px 10px;border:1px solid #ddd;border-radius:6px;background:white;color:inherit}button,input{font:inherit}</style><div id="regex_container"><div class="regex_settings"><div class="inline-drawer"><button id="native-toggle" onclick="document.querySelector('.inline-drawer-content').hidden=!document.querySelector('.inline-drawer-content').hidden">正则</button><div class="inline-drawer-content"><h4>全局正则</h4><div id="saved_regex_scripts"><div id="ordinary">普通全局正则</div></div></div></div></div></div><script>window.fixture={active:['娱乐圈'],books:{},events:{},settings:{regex:[{id:'ordinary',scriptName:'普通全局正则',findRegex:'/abc/g',replaceString:'xyz',placement:[2]}]},context:{chat:[],characters:[],loadWorldInfo:async name=>structuredClone(window.fixture.books[name]),saveSettingsDebounced:()=>{},saveWorldInfo:async(name,data)=>{window.fixture.books[name]=structuredClone(data)}}};window.toastr={error:(...args)=>console.error(...args),warning:console.warn};window.confirm=()=>true;</script>`});
 });
 await page.goto('http://wbr.test/');
 await page.evaluate(async prefix=>{
  const core=await import(prefix+'worldbook-regex-core.js');
  fixture.books['娱乐圈']=core.writeBundle({entries:{}},[core.normalizeRegex({id:'status',scriptName:'演艺事业状态栏',findRegex:'/foo/g',replaceString:'bar'})]);
  fixture.books['哨向']=core.writeBundle({entries:{}},[core.normalizeRegex({id:'sense',scriptName:'精神力状态栏',findRegex:'/abc/g'})]);
  window.wbr=await import(prefix+'worldbook-regex.js');await wbr.initWorldbookRegex();
  const stored=fixture.settings.regex.find(core.isManaged);
  const row=document.createElement('div');row.id=stored.id;row.textContent='不应该出现在全局的副本';document.querySelector('#saved_regex_scripts').append(row);
 },prefix);
 assert.equal(await page.locator('.inline-drawer-content #wbr-native-panel').count(),1);
 await page.locator('#native-toggle').click();
 assert.equal(await page.locator('#wbr-native-panel').isVisible(),false);
 await page.locator('#native-toggle').click();
 await page.locator('#wbr-native-panel > summary').click();
 await page.locator('.wbr-book-group > summary').click();
 await page.waitForTimeout(50);
 assert.equal(await page.locator('#saved_regex_scripts .wbr-managed-row').isVisible(),false);
 assert.equal(await page.locator('.wbr-rule').count(),1);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'mobile panel must fit viewport');
 await page.locator('.wbr-rule button').click();
 const modal=page.locator('dialog');
 await modal.locator('input').first().fill('修改后的状态栏');
 await modal.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>fixture.books['娱乐圈'].extensions.kelaode_worldbook_regex.regexes[0].scriptName==='修改后的状态栏');
 await page.evaluate(()=>wbr.openManager('娱乐圈'));
 await page.getByRole('button',{name:'复制已有',exact:true}).click();
 await page.locator('dialog').last().locator('input[type=checkbox]').check();
 await page.getByRole('button',{name:'复制到世界书',exact:true}).click();
 await page.waitForFunction(()=>fixture.books['娱乐圈'].extensions.kelaode_worldbook_regex.regexes.length===2,{},{timeout:3000});
 await page.locator('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await page.evaluate(async()=>{fixture.active=['哨向'];await wbr.synchronize()});
 assert.match(await page.locator('#wbr-native-panel').textContent(),/哨向/);
 assert.doesNotMatch(await page.locator('#wbr-native-panel').textContent(),/娱乐圈/);
 await page.evaluate(async()=>{fixture.active=[];await wbr.synchronize()});
 assert.equal(await page.evaluate(()=>fixture.settings.regex.length),1);
 await page.locator('#wbr-native-panel > label input').uncheck();
 assert.equal(await page.evaluate(()=>fixture.settings.kelaode_worldbook_regex_enabled),false);
 await page.evaluate(async prefix=>{
  const long='这是一本名称非常非常长的世界书'.repeat(12);
  fixture.books[long]={entries:{}};
  const {STATE}=await import(prefix+'state.js');STATE.currentBookName=long;
  const {UI}=await import(prefix+'ui.js');window.managerUI=UI;
  await UI.open();
 },prefix);
 await page.locator('#wb-trigger-wb-book-selector').click();
 await page.locator('#wb-active-dropdown .wb-gr-option').filter({hasText:'这是一本名称非常非常长的世界书'.repeat(12)}).click();
 await page.waitForTimeout(60);
 for(const selector of ['#wb-trigger-wb-book-selector','#btn-wb-analysis','#btn-wb-menu-trigger','#btn-wb-menu-theme']) {
  const rect=await page.locator(selector).boundingBox();
  assert.ok(rect && rect.x>=0 && rect.x+rect.width<=390, selector+' must fit the phone');
 }
 await page.getByRole('tab',{name:'配套正则',exact:true}).click();
 assert.equal(await page.locator('#wb-entry-editor').isVisible(),false);
 assert.equal(await page.locator('#wb-regex-editor').isVisible(),true);
 assert.equal(await page.locator('#wb-regex-editor').getByRole('button',{name:'新建',exact:true}).count(),1);
 assert.equal(await page.locator('dialog').count(),0,'switching to regex must not open a modal');
 await page.getByRole('tab',{name:'条目',exact:true}).click();
 assert.equal(await page.locator('#wb-entry-editor').isVisible(),true);

 if(process.env.XUBAI_STATUSBAR_REPO_PATH) {
  await page.locator('#wb-close').dispatchEvent('click');
  const generatorRoot=process.env.XUBAI_STATUSBAR_REPO_PATH;
  const bindingSource=fs.readFileSync(generatorRoot+'/src/10a-worldbook-binding.part.js','utf8');
  const events=fs.readFileSync(generatorRoot+'/src/16-events.part.js','utf8');
  const saveSource=events.slice(events.indexOf('        async function saveRegexResult('),events.indexOf("        on(panel.querySelector('#ab-save'),"));
  const filters=fs.readFileSync(generatorRoot+'/src/10-regex-preview.part.js','utf8');
  const filterSource=filters.slice(filters.indexOf('    function makeStatusFilter('),filters.indexOf('    // ================= 读写酒馆正则'));
  await page.evaluate(({bindingSource,saveSource,filterSource})=>{
   fixture.books['主世界书']={entries:{}};fixture.primary='主世界书';
   fixture.books['备用娱乐圈']={entries:{}};fixture.active=['娱乐圈','主世界书'];
   const panel=document.createElement('div');panel.id='aibar-panel';
   panel.innerHTML='<div><select id="ab-scope"><option value="global">全局</option><option value="worldbook">世界书</option></select></div><button id="ab-save">保存为新正则</button><select id="ab-font-select"><option value=""></option></select><input id="ab-add-filter" type="checkbox" checked><input id="ab-keep-floors" value="1"><div id="ab-apply-depth-wrap" hidden><input id="ab-apply-depth" type="checkbox"></div>';
   document.body.append(panel);fixture.toasts=[];
   const deps={panel,session:{scriptName:'联动状态栏',findRegex:'/<status>[\\s\\S]*?<\\/status>/g',replaceStringRaw:'<div>$1</div>',assignments:{}},
    toast:(message,type)=>fixture.toasts.push({message,type}),mintConfirm:async()=>true,ensureAssignedUrl:async x=>x,
    persistSessionImages:async()=>{},extractPlaceholderKeys:()=>[],getFont:async()=>null,buildFontBlock:()=>'',
    generateUUID:()=>Math.random().toString(36).slice(2),updateTavernRegexesWith:()=>{throw new Error('Worldbook save must not write ordinary regexes')}};
   const scope='const {'+Object.keys(deps).join(',')+'}=deps;';
   const api=new Function('targetWindow','targetDoc','on','deps',scope+bindingSource+filterSource+saveSource+';return {installWorldbookBindingControls,saveRegexResult};')(window,document,(node,event,handler)=>node.addEventListener(event,handler),deps);
   fixture.generatorApi=api;api.installWorldbookBindingControls(panel);
  },{bindingSource,saveSource,filterSource});
  await page.selectOption('#ab-scope','worldbook');
  await page.waitForFunction(()=>document.querySelector('#ab-bind-worldbook').options.length===2);
  assert.deepEqual(await page.locator('#ab-bind-worldbook option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','娱乐圈']);
  await page.locator('#ab-bind-keyword').fill('备用');
  assert.equal(await page.locator('#ab-bind-worldbook option').count(),1);
  await page.locator('#ab-bind-global-only').uncheck();
  await page.selectOption('#ab-bind-worldbook','备用娱乐圈');
  await page.locator('#ab-bind-global-only').check();
  assert.equal(await page.locator('#ab-bind-worldbook').inputValue(),'','hidden selection must be cleared');
  await page.locator('#ab-bind-global-only').uncheck();
  await page.selectOption('#ab-bind-worldbook','备用娱乐圈');
  await page.evaluate(()=>fixture.generatorApi.saveRegexResult(false));
  assert.equal(await page.evaluate(()=>fixture.books['备用娱乐圈'].extensions?.kelaode_worldbook_regex?.regexes.length),2,
   JSON.stringify(await page.evaluate(()=>fixture.toasts)));
  const saved=await page.evaluate(()=>fixture.books['备用娱乐圈'].extensions.kelaode_worldbook_regex.regexes);
  assert.equal(saved[0].markdownOnly,true);
  assert.equal(saved[1].promptOnly,true);
  assert.equal(saved[1].minDepth,3);
  assert.equal(await page.evaluate(()=>fixture.settings.regex.length),1,'binding must not create duplicate ordinary globals');
  assert.deepEqual(await page.evaluate(()=>fixture.active),['娱乐圈','主世界书'],'binding must not enable the destination');
 }
 assert.deepEqual(errors,[]);
 console.log('PASS mobile: hidden native copies, separate groups, editor save, copy existing, switch and disable, no page errors');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
