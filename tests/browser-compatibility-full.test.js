'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');const {chromium,firefox,webkit}=require('playwright');
const browserName=process.env.TEST_BROWSER||'chromium',browserType={chromium,firefox,webkit}[browserName];
if(!browserType)throw new Error(`Unknown TEST_BROWSER: ${browserName}`);
const samples=require('./fixtures/full-hangul');
const url=process.env.APP_URL||'http://127.0.0.1:4176/';
const OUT=process.env.COMPAT_TEST_DIR||path.join(os.tmpdir(),`geulmoa-compatibility-tests-${browserName}`);fs.mkdirSync(OUT,{recursive:true});
(async()=>{
 const browser=await browserType.launch({headless:true,...(browserName==='chromium'?{args:['--no-sandbox']}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(data=>{
   localStorage.setItem('geulmoa-drawing-v1',JSON.stringify({samples:data,custom:[],current:'가',fontName:'Full Compat QA',preview:'안녕하세요 나만의 손글씨'}));
   localStorage.setItem('geulmoa-font-design-profiles-v1',JSON.stringify({version:1,profiles:{'Full Compat QA':{cleanupStrength:80,device:'auto',letterSpacing:130,wordSpace:750,verticalOffset:80}}}));
   window.Worker=undefined;window.__ticks=0;window.__maxGap=0;let previous=performance.now();
   setInterval(()=>{const now=performance.now();window.__maxGap=Math.max(window.__maxGap,now-previous);previous=now;window.__ticks++;},25);
   window.__status=[];document.addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>window.__status.push(document.querySelector('#build-status').textContent)).observe(document.querySelector('#build-status'),{childList:true,subtree:true,characterData:true}));
  },samples);
  await page.goto(url,{waitUntil:'domcontentloaded'});
  assert.match(await page.locator('#base-progress').innerText(),/16\s*\/\s*16/);
  const start=Date.now();await page.locator('#build-font').click();
  await page.waitForFunction(()=>!document.querySelector('#build-font').disabled && (!document.querySelector('#download-font').hidden||document.querySelector('#build-status').classList.contains('error')),null,{timeout:300000});
  const elapsed=Date.now()-start,status=await page.locator('#build-status').innerText();
  assert.match(status,/브라우저 호환 모드로 만들었어요/);assert.match(await page.locator('#stat-coverage').innerText(),/11,172/);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-font').click()]);const file=path.join(OUT,'full-compat.ttf');await download.saveAs(file);
  const py=`from fontTools.ttLib import TTFont\nimport sys\nf=TTFont(sys.argv[1]); c=f.getBestCmap()\nassert all(i in c for i in range(0xac00,0xd7a4))\nassert f['hmtx'][c[ord('가')]][0]==1130\nassert f['hmtx'][c[ord(' ')]][0]==750\nassert (f['OS/2'].sxHeight,f['OS/2'].sCapHeight)==(560,780)\nassert f['hhea'].ascent>=f['head'].yMax and f['hhea'].descent<=f['head'].yMin\nprint('fontTools verified all 11,172 Hangul syllables, advances and vertical bounds')`;
  console.log(execFileSync('python',['-c',py,file],{encoding:'utf8'}).trim());
  const perf=await page.evaluate(()=>({ticks:window.__ticks,maxGap:Math.round(window.__maxGap),progress:window.__status}));
  assert(perf.ticks>10,JSON.stringify(perf));assert(perf.progress.some(s=>s.includes('글자를 분석')));assert(perf.progress.some(s=>s.includes('조합')));
  assert.deepEqual(errors,[]);
  console.log(`full compatibility build: ${elapsed}ms, ${perf.ticks} event-loop ticks, max task gap ${perf.maxGap}ms, ${fs.statSync(file).size} bytes`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
