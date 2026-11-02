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
 [prefix+'api.js']:`export const API={getGlobalBindings:async()=>window.fixture.active,getCharBindings:async()=>({primary:null,additional:[]}),getChatBinding:async()=>null};`,
 [prefix+'state.js']:`export const STATE={currentBookName:'娱乐圈'};`,
 };
 await page.route('http://wbr.test/**', async route=>{
   const path=new URL(route.request().url()).pathname;
   if(mocks[path]) return route.fulfill({contentType:'text/javascript',body:mocks[path]});
   if(path.startsWith(prefix)) {
    const file=root+path.slice(prefix.length);
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
   }
   await route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css"><style>body{background:#f7f5f2;color:#333;font-family:sans-serif;padding:14px;--SmartThemeBodyColor:#333;--SmartThemeBlurTintColor:#fff;--SmartThemeBorderColor:#ddd} .menu_button{padding:7px 10px;border:1px solid #ddd;border-radius:6px;background:white;color:inherit}button,input{font:inherit}</style><div id="regex_container"><h3>正则</h3><h4>全局正则</h4><div id="saved_regex_scripts"><div id="ordinary">普通全局正则</div></div></div><script>window.fixture={active:['娱乐圈'],books:{},events:{},settings:{regex:[{id:'ordinary',scriptName:'普通全局正则',findRegex:'/abc/g',replaceString:'xyz',placement:[2]}]},context:{chat:[],loadWorldInfo:async name=>structuredClone(window.fixture.books[name]),saveSettingsDebounced:()=>{},saveWorldInfo:async(name,data)=>{window.fixture.books[name]=structuredClone(data)}}};window.toastr={error:(...args)=>console.error(...args),warning:console.warn};window.confirm=()=>true;</script>`});
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
 assert.deepEqual(errors,[]);
 console.log('PASS mobile: hidden native copies, separate groups, editor save, copy existing, switch and disable, no page errors');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
