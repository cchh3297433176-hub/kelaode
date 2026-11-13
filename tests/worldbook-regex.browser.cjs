const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright' : 'playwright');
const fs = require('fs');
const assert = require('assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.WBR_BROWSER_PATH || undefined, args:['--no-sandbox', '--disable-dev-shm-usage']});
 const page = await browser.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:1 });
 page.setDefaultTimeout(5000);
 const errors=[]; page.on('console',msg=>{if(msg.type()==='error') console.log('BROWSER ERROR',msg.text())}); page.on('pageerror', e=>errors.push(e.message));
 const root=require('path').resolve(__dirname,'..')+'/';
 const prefix='/scripts/extensions/third-party/kelaode/';
 const mocks={
 '/scripts/extensions.js':`export const extension_settings=window.fixture.settings; export const getContext=()=>window.fixture.context;`,
 '/script.js':`export const event_types={CHAT_CHANGED:'chat',WORLDINFO_SETTINGS_UPDATED:'world',WORLDINFO_UPDATED:'updated',GENERATION_AFTER_COMMANDS:'generation'}; export const eventSource={emit:async()=>{},on:(name,fn)=>(window.fixture.events[name]??=[]).push(fn)}; export function updateMessageBlock(){}`,
 '/scripts/world-info.js':`export const worldInfoCache=new Map(); export const world_names=['A','B'];`,
 '/scripts/power-user.js':`export const power_user={};`,
 '/scripts/extensions/regex/engine.js':`export const SCRIPT_TYPES={GLOBAL:'global',SCOPED:'scoped',PRESET:'preset'}; export const getScriptsByType=type=>type==='global'?fixture.settings.regex:[]; export const saveScriptsByType=async scripts=>{fixture.settings.regex=scripts}; export const getCurrentPresetAPI=()=>null; export const getCurrentPresetName=()=>null;`,
 [prefix+'api.js']:`export const API={getAllBookNames:async()=>Object.keys(window.fixture.books),getGlobalBindings:async()=>window.fixture.active,getCharBindings:async()=>({primary:window.fixture.primary||null,additional:[]}),getChatBinding:async()=>null,getAllBoundBookNames:async()=>fixture.bindings||{},getMetadata:()=>fixture.metadata||{},loadBook:async name=>Object.values((await fixture.context.loadWorldInfo(name)).entries)};`,
 [prefix+'actions.js']:`import {STATE} from './state.js'; export const Actions={flushPendingSave:async()=>{},applyTheme:()=>{},switchView:()=>{},getTokenCount:()=>0,refreshAllContext:async()=>{STATE.allBookNames=Object.keys(fixture.books);STATE.bindings={char:{primary:null,additional:[]},global:fixture.active,chat:null}},loadBook:async name=>{STATE.currentBookName=name;const {UI}=await import('./ui.js');UI.renderBookSelector();UI.renderList();await UI.renderRegexEditor();}};`,
 };
 await page.route('http://wbr.test/**', async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/worldinfo/edit') {
    const {name,data}=route.request().postDataJSON();
    if(await page.evaluate(()=>fixture.rejectSave)) return route.fulfill({status:503});
    await page.evaluate(({name,data})=>{fixture.books[name]=data},{name,data});
    return route.fulfill({json:{ok:true}});
   }
   if(mocks[path]) return route.fulfill({contentType:'text/javascript',body:mocks[path]});
   if(path.startsWith(prefix)) {
    const file=root+path.slice(prefix.length);
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
   }
   await route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css"><style>body{background:#f7f5f2;color:#333;font-family:sans-serif;padding:14px;--SmartThemeBodyColor:#333;--SmartThemeBlurTintColor:#fff;--SmartThemeBorderColor:#ddd} .menu_button{padding:7px 10px;border:1px solid #ddd;border-radius:6px;background:white;color:inherit}button,input{font:inherit}</style><div id="regex_container"><div class="regex_settings"><div class="inline-drawer"><button id="native-toggle" onclick="document.querySelector('.inline-drawer-content').hidden=!document.querySelector('.inline-drawer-content').hidden">正则</button><div class="inline-drawer-content"><h4>全局正则</h4><div id="saved_regex_scripts"><div id="ordinary">普通全局正则</div></div></div></div></div></div><script>window.fixture={active:['娱乐圈'],books:{},events:{},settings:{regex:[{id:'ordinary',scriptName:'普通全局正则',findRegex:'/abc/g',replaceString:'xyz',placement:[2]}]},context:{getRequestHeaders:()=>({}),chat:[],characters:[],loadWorldInfo:async name=>structuredClone(window.fixture.books[name]),saveSettingsDebounced:()=>{},saveWorldInfo:async(name,data)=>{window.fixture.books[name]=structuredClone(data)}}};window.toastr={error:(...args)=>console.error(...args),warning:console.warn};window.confirm=()=>true;</script>`});
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
 await page.evaluate(()=>{
  for(let i=0;i<40;i++) fixture.settings.regex.push({id:'extra-'+i,scriptName:'长列表测试 '+i,findRegex:'x',placement:[2]});
 });
 await page.getByRole('button',{name:'移动已有',exact:true}).click();
 const picker=page.locator('.wbr-picker');
 assert.equal(await picker.locator('summary').count(),3);
 assert.ok(await picker.locator('.wbr-picker-list').evaluate(el=>el.scrollHeight>el.clientHeight));
 const confirmMove=picker.getByRole('button',{name:'移到世界书',exact:true});
 const position=await confirmMove.boundingBox();
 await picker.locator('.wbr-picker-list').evaluate(el=>el.scrollTop=el.scrollHeight);
 assert.deepEqual(await confirmMove.boundingBox(),position);
 await picker.getByRole('checkbox',{name:'普通全局正则',exact:true}).check();
 await page.getByRole('button',{name:'移到世界书',exact:true}).click();
 await page.waitForFunction(()=>fixture.books['娱乐圈'].extensions.kelaode_worldbook_regex.regexes.length===2,{},{timeout:3000});
 await picker.waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>fixture.settings.regex.some(rule=>rule.id==='ordinary')),false);
 await page.evaluate(()=>{fixture.settings.regex=fixture.settings.regex.filter(rule=>!rule.id.startsWith('extra-'))});
 await page.locator('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await page.evaluate(async()=>{fixture.active=['哨向'];await wbr.synchronize()});
 assert.match(await page.locator('#wbr-native-panel').textContent(),/哨向/);
 assert.doesNotMatch(await page.locator('#wbr-native-panel').textContent(),/娱乐圈/);
 await page.evaluate(async()=>{fixture.active=[];await wbr.synchronize()});
 assert.equal(await page.evaluate(()=>fixture.settings.regex.length),0);
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

 await page.evaluate(async prefix=>{
  const {STATE}=await import(prefix+'state.js');
  window.toastr.success=()=>{};
  fixture.randomBook=STATE.currentBookName;
  fixture.books[fixture.randomBook]={
   extensions:{test:'保留'},
   entries:{
    0:{uid:0,comment:'常驻总控',constant:true,content:'格式'},
    1:{uid:1,comment:'01 论坛',constant:false,key:['论坛'],content:'题材一'},
    2:{uid:2,comment:'02 新闻',constant:false,key:['新闻'],content:'题材二'},
    3:{uid:3,comment:'其他组',constant:false,group:'原组',content:'不改'},
   },
  };
 },prefix);
 const randomButton=page.getByRole('button',{name:'随机组',exact:true});
 assert.equal(await randomButton.locator('svg').count(),1);
 const randomBounds=await randomButton.boundingBox();
 assert.ok(randomBounds && randomBounds.x>=0 && randomBounds.x+randomBounds.width<=390);
 await randomButton.click();
 const random=page.getByRole('dialog',{name:'随机组'});
 assert.ok(await random.getByRole('checkbox',{name:/其他组/}).isDisabled());
 await random.getByRole('checkbox',{name:'01 论坛'}).check();
 await random.getByRole('searchbox').fill('新闻');
 await random.getByRole('checkbox',{name:'02 新闻'}).check();
 assert.match(await random.locator('[data-status]').textContent(),/已选 2 条.*等概率/);
 await random.getByRole('button',{name:'试抽'}).click();
 assert.match(await random.locator('[data-status]').textContent(),/试抽到\s*「0[12]/);
 await page.evaluate(()=>fixture.rejectSave=true);
 await random.getByRole('button',{name:'创建随机组'}).click();
 await random.getByText(/HTTP 503/).waitFor();
 assert.equal(await page.evaluate(()=>fixture.books[fixture.randomBook].entries[1].constant),false);
 await page.evaluate(()=>fixture.rejectSave=false);
 await random.getByRole('button',{name:'创建随机组'}).click();
 await random.waitFor({state:'detached'});
 const savedGroup=await page.evaluate(()=>fixture.books[fixture.randomBook]);
 assert.equal(savedGroup.extensions.test,'保留');
 assert.equal(savedGroup.entries[0].group,undefined);
 assert.equal(savedGroup.entries[3].group,'原组');
 assert.equal(savedGroup.entries[1].constant,true);
 assert.equal(savedGroup.entries[1].groupWeight,100);
 assert.equal(savedGroup.entries[1].group,savedGroup.entries[2].group);
 assert.deepEqual(savedGroup.entries[1].key,['论坛']);
 assert.equal(savedGroup.entries[1].content,'题材一');
 await randomButton.click();
 await random.getByRole('combobox').selectOption(savedGroup.entries[1].group);
 await random.getByRole('checkbox',{name:'01 论坛'}).uncheck();
 assert.match(await random.locator('[data-status]').textContent(),/移出并停用 1 条/);
 await random.getByRole('button',{name:'保存随机组'}).click();
 await random.waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>fixture.books[fixture.randomBook].entries[1].disable),true);
 await randomButton.click();
 await random.waitFor();
 await page.keyboard.press('Escape');
 await random.waitFor({state:'detached'});
 assert.ok(await randomButton.isVisible());

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
 await page.setViewportSize({width:320,height:640});
 const longName='超长的世界书名字'+ 'WorldbookWithoutSpaces'.repeat(4);
 await page.evaluate(async ({prefix,longName})=>{
  document.getElementById('enhanced-wb-panel-v6')?.remove();
  fixture.books={
   [longName]:{entries:{0:{uid:0,comment:'示例',content:'测试'}}},
   '小剧场':{entries:{}}, '当前主书':{entries:{}}, '其他角色主书':{entries:{}},
  };
  fixture.active=[longName,'当前主书'];
  fixture.primary='当前主书';
  fixture.bindings={'其他角色主书':{primary:['角色']}};
  fixture.metadata={[longName]:{tags:['日常']},'小剧场':{tags:['剧场']},'当前主书':{tags:['日常']}};
  fixture.settings.kelaode_worldbook_quick={pins:Object.keys(fixture.books)};
  fixture.settings.kelaode_worldbook_regex_enabled=false;
  Object.assign(fixture.context,{chatId:'quick-test',chatMetadata:{},saveMetadataDebounced(){}});
  const shell=document.createElement('div');
  shell.id='sheld';
  shell.style.cssText='position:relative;width:100%;height:540px';
  shell.innerHTML='<div id="form_sheld" style="height:55px"></div>';
  document.body.replaceChildren(shell);
  const theme=document.createElement('style');
  theme.textContent='input[type=checkbox]{appearance:none!important;background:#fff!important} button{border:3px solid pink!important;background:pink!important;box-shadow:0 2px 4px #000!important} button::after{content:"★"!important}';
  document.head.append(theme);
  const {initWorldbookQuick}=await import(prefix+'worldbook-quick.js');
  initWorldbookQuick();
 },{prefix,longName});
 const ball=page.getByRole('button',{name:'世界书悬浮球'});
 const quick=page.locator('#wb-quick-menu');
 await ball.click();
 const toggle=quick.getByRole('switch',{name:longName,exact:true});
 await toggle.waitFor();
 assert.equal(await quick.getByRole('switch').count(),2);
 assert.equal(await toggle.getAttribute('aria-checked'),'true');
 assert.equal(await toggle.textContent(),'开');
 const track=toggle.locator('.wb-quick-switch-track');
 assert.equal(await track.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(36, 100, 72)');
 assert.equal(await track.evaluate(el=>getComputedStyle(el).flexDirection),'row-reverse');
 const snapshot=quick.getByRole('button',{name:longName+'的条目快照'});
 const rects=await Promise.all([quick.boundingBox(),toggle.boundingBox(),snapshot.boundingBox()]);
 assert.ok(rects[1].x+rects[1].width+9<=rects[2].x);
 assert.ok(rects[2].x+rects[2].width<=rects[0].x+rects[0].width);
 assert.ok(await quick.locator('.wb-quick-name').first().evaluate(el=>el.offsetHeight>parseFloat(getComputedStyle(el).lineHeight)));
 await toggle.click();
 assert.equal(await toggle.getAttribute('aria-checked'),'false');
 assert.equal(await toggle.textContent(),'关');
 assert.equal(await track.evaluate(el=>getComputedStyle(el).flexDirection),'row');
 await quick.getByRole('combobox',{name:'按标签筛选'}).selectOption('日常');
 assert.equal(await quick.getByRole('switch').count(),1);
 assert.equal(await toggle.getAttribute('aria-checked'),'false','filtering must preserve the active chat override');
 await quick.getByRole('button',{name:'显示主书'}).click();
 assert.equal(await quick.getByRole('switch',{name:'当前主书'}).getAttribute('aria-checked'),'true');
 await quick.getByRole('combobox').selectOption('');
 assert.equal(await quick.getByRole('switch').count(),4);
 await quick.getByRole('button',{name:'显示主书'}).click();
 assert.equal(await quick.getByRole('switch').count(),2);
 await snapshot.click();
 const snapshots=page.getByRole('dialog');
 await snapshots.getByText('条目快照',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await ball.click();
 await quick.getByRole('button',{name:'悬浮球设置'}).click();
 const settings=page.getByRole('dialog',{name:'悬浮球设置'});
 const pin=settings.getByRole('switch',{name:longName,exact:true});
 await pin.waitFor();
 assert.equal(await settings.getByRole('switch',{name:'当前主书',exact:true}).count(),0);
 await settings.getByRole('combobox').selectOption('日常');
 assert.equal(await settings.locator('[data-pins]').getByRole('switch').count(),1);
 await settings.getByRole('button',{name:'显示主书'}).click();
 assert.equal(await settings.getByRole('switch',{name:'当前主书',exact:true}).getAttribute('aria-checked'),'true');
 assert.equal(await pin.getAttribute('aria-checked'),'true');
 await pin.click();
 assert.equal(await pin.getAttribute('aria-checked'),'false');
 assert.equal(await page.evaluate(name=>fixture.settings.kelaode_worldbook_quick.pins.includes(name),longName),false);
 await pin.click();
 await settings.locator('[data-file]').setInputFiles({
  name:'测试.gif',mimeType:'image/gif',buffer:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'),
 });
 await settings.locator('[data-image-name]').getByText('测试.gif').waitFor();
 await settings.locator('[data-close]').click();
 const picture=await ball.evaluate(el=>{
  const css=getComputedStyle(el), image=getComputedStyle(el.querySelector('img'));
  return [css.backgroundColor,css.borderWidth,css.boxShadow,image.borderRadius];
 });
 assert.deepEqual(picture,['rgba(0, 0, 0, 0)','0px','none','0px']);
 await ball.click();
 assert.equal(await quick.getByRole('button',{name:'显示主书'}).getAttribute('aria-pressed'),'false');
 assert.equal(await quick.getByRole('switch',{name:'其他角色主书',exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS mobile: regex, random groups, quick switches, long names, tag/primary filters, snapshots and frameless GIF');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
