'use strict';
// Responsive layout and actual draw → paint → build flow. All handwriting is
// synthetic; real stylus/touch-device quality still needs hands-on validation.
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {chromium,firefox,webkit}=require('playwright');
const name=process.env.TEST_BROWSER||'chromium',engine={chromium,firefox,webkit}[name];
if(!engine)throw new Error(`Unknown TEST_BROWSER: ${name}`);
const url=process.env.APP_URL||'http://127.0.0.1:4176/';
const OUT=process.env.MOBILE_TEST_DIR||path.join(os.tmpdir(),`geulmoa-mobile-tests-${name}`);fs.mkdirSync(OUT,{recursive:true});
async function noOverflow(page,label){
 const size=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:window.innerWidth}));
 assert(size.document<=size.viewport,`${label}: horizontal overflow ${JSON.stringify(size)}`);
}
async function touchStroke(page,points){
 await page.locator('#pad').evaluate((canvas,points)=>{
  const r=canvas.getBoundingClientRect();points.forEach(([x,y],i)=>canvas.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===points.length-1?'pointerup':'pointermove',{bubbles:true,cancelable:true,pointerId:8,pointerType:'touch',isPrimary:true,clientX:r.x+x*r.width,clientY:r.y+y*r.height})));
 },points);
}
async function build(page){
 await page.locator('#build-font').click();
 await page.waitForFunction(()=>!document.querySelector('#build-font').disabled && (!document.querySelector('#download-font').hidden||document.querySelector('#build-status').classList.contains('error')),null,{timeout:120000});
 assert(!await page.locator('#build-status').evaluate(e=>e.classList.contains('error')),await page.locator('#build-status').innerText());
}
(async()=>{
 const browser=await engine.launch({headless:true,...(name==='chromium'?{args:['--no-sandbox']}:{})});
 try{
  for(const width of [320,360,390,768]){
   const ctx=await browser.newContext({viewport:{width,height:844},hasTouch:true,...(width<600&&name!=='firefox'?{isMobile:true}:{}),acceptDownloads:true});
   const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url,{waitUntil:'domcontentloaded'});
   await noOverflow(page,`${name}/${width} initial`);
   const order=await page.evaluate(()=>[...document.querySelector('main').children].map(e=>e.id||e.className));
   assert.equal(order[order.length-1],'designer');assert(order.indexOf('preview')<order.indexOf('thickness-test'));assert(order.indexOf('thickness-test')<order.indexOf('designer'));
   assert(!(await page.locator('#thickness-details').evaluate(e=>e.open)),'optional vector comparison starts closed');
   assert(await page.locator('#thickness-result').isHidden(),'no expensive comparison started on load');
   if(width<=720){
    assert(await page.locator('.mobile-nav').isVisible());
    await page.locator('#quick-sample-list [data-char="트"]').click();
    assert.equal(await page.locator('#target-char').innerText(),'트');assert.equal(await page.locator('#quick-sample-list [data-char="트"]').getAttribute('aria-pressed'),'true');
    await page.locator('#landing-prev').click();assert.equal(await page.locator('#target-char').innerText(),'넷');
    const visible=await page.locator('#quick-sample-list').evaluate(row=>{const a=row.querySelector('.active').getBoundingClientRect(),r=row.getBoundingClientRect();return a.left>=r.left-1&&a.right<=r.right+1;});
    assert(visible,'selected quick sample is scrolled into view');
    await page.locator('.quick-samples-heading a').click();assert.equal(new URL(page.url()).hash,'#sample-list');
    await page.locator('.sample-chip').filter({hasText:/^가$/}).first().click();
    assert.equal(await page.locator('#target-char').innerText(),'가');
    await page.waitForTimeout(700);
    const top=await page.evaluate(()=>({title:document.querySelector('#drawing-title').getBoundingClientRect().top,nav:document.querySelector('.mobile-nav').getBoundingClientRect().bottom}));
    assert(top.title>=top.nav-1 && top.title<top.nav+45,`selection returns to the writing pad ${JSON.stringify(top)}`);
   }else assert(await page.locator('.mobile-nav').isHidden());
   await page.locator('.backup-manual summary').click();await page.locator('#backup-make-text').click();
   assert((await page.locator('#backup-text').inputValue()).includes('samples'));
   await noOverflow(page,`${name}/${width} backup open`);
   if(width===320){
    await page.locator('#thickness-details > summary').click();
    await page.waitForFunction(()=>!document.querySelector('#thickness-result').hidden||document.querySelector('#thickness-status').classList.contains('error'),null,{timeout:120000});
    assert(!await page.locator('#thickness-status').evaluate(e=>e.classList.contains('error')),await page.locator('#thickness-status').innerText());
    await noOverflow(page,`${name}/${width} vector results open`);
   }
   if(width===390){
    const lead=[[.18,.2],[.49,.2],[.49,.65]],vowel=[[.7,.16],[.7,.76]];
    await page.locator('#start-writing').click();
    await touchStroke(page,lead);await touchStroke(page,vowel);await page.locator('#next-step').click();
    await touchStroke(page,lead);await page.locator('#next-step').click();await touchStroke(page,vowel);
    assert.match(await page.locator('#paint-status').innerText(),/모든 획을 자모별로 나눴어요/);
    assert(await page.locator('.sample-chip.done').filter({hasText:/^가$/}).count());
    await page.locator('#capture-close').click();
    await page.locator('.mobile-nav a[href="#preview"]').click();await build(page);
    assert.equal(await page.locator('#font-state').innerText(),'내 손글씨 폰트 적용 중');
    const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#download-font').click()]);
    const file=path.join(OUT,`${name}-mobile.ttf`);await dl.saveAs(file);assert.deepEqual([...fs.readFileSync(file).subarray(0,4)],[0,1,0,0]);
    await noOverflow(page,`${name}/${width} generation result`);
    await page.locator('.mobile-nav a[href="#designer"]').click();
    assert.equal(await page.locator('#design-mini-source').innerText(),'내 폰트');
    const before=await page.locator('#design-mini-specimen').evaluate(c=>c.toDataURL());
    await page.locator('#design-spacing').evaluate(e=>{e.value='130';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(old=>document.querySelector('#design-mini-specimen').toDataURL()!==old,before);
    assert.match(await page.locator('#design-mini-source').innerText(),/다시 생성 필요/);
    assert.match(await page.locator('#download-font').innerText(),/이전 상태 TTF/);
    await page.locator('#design-spacing').scrollIntoViewIfNeeded();await page.waitForTimeout(150);
    const sticky=await page.evaluate(()=>({mini:document.querySelector('.designer-mini').getBoundingClientRect().top,nav:document.querySelector('.mobile-nav').getBoundingClientRect().bottom}));
    assert(sticky.mini>=sticky.nav-1 && sticky.mini<=sticky.nav+12,`compact specimen sticks below navigation ${JSON.stringify(sticky)}`);
    await noOverflow(page,`${name}/${width} adjusted`);
    await page.locator('.designer-footnote a').click();await build(page);
    assert.match(await page.locator('#download-font').innerText(),/^TTF 다운로드/);
    if(name==='chromium'){await page.locator('#designer').screenshot({path:path.join(OUT,'mobile-final-designer.png')});await page.locator('#studio').screenshot({path:path.join(OUT,'mobile-final-studio.png')});}
   }
   assert.deepEqual(errors,[]);await ctx.close();console.log(`${name} ${width}px: responsive layout and navigation passed${width===390?'; touch draw/color/build/download/design/rebuild passed':''}${width===320?'; optional vector lab passed':''}`);
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
