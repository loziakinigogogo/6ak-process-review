'use strict';
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {chromium,expect}=require('@playwright/test');
const {startServer}=require('../workbench/scripts/workbench.cjs');
async function main(){
  const directory=path.resolve('.qa/workbench-content-list-browser',`run-${Date.now()}`);fs.mkdirSync(directory,{recursive:true});
  const model=require('../workbench/scripts/workbench-demo-fixture.cjs').createDemoModel();
  model.nodes.find(node=>node.id==='validate').fields.rules=[]; // Existing adopted claim intentionally outside fixed fields.
  const source={id:'preview-actions',name:'合成预览操作资料',text:'校验后记录本次完成时间。',sha256:require('node:crypto').createHash('sha256').update('校验后记录本次完成时间。').digest('hex')};
  const extraAction={id:'validate-second-action',text:source.text,origin:'explicit',evidence:[{sourceId:source.id,startLine:1,endLine:1,quote:source.text}]};
  model.sources.push(source);model.claims.push(extraAction);model.coverage.push({sourceId:source.id,startLine:1,endLine:1,disposition:'represented',claimIds:[extraAction.id],issueIds:[],reason:'隔离预览回归的第二条操作'});
  model.nodes.find(node=>node.id==='validate').claimIds.push(extraAction.id);model.nodes.find(node=>node.id==='validate').fields.actions.push(extraAction.id);
  const noActions=model.nodes.find(node=>node.id==='manual');noActions.claimIds=noActions.claimIds.filter(id=>!noActions.fields.actions.includes(id));noActions.fields.actions=[];

  const initialStore=require('../workbench/scripts/workbench-store.cjs').createStore(path.join(directory,'task'),{model,initialGroupId:'execute'});
  initialStore.updateView({workMode:'read',contentView:'content'});
  const app=await startServer({taskDirectory:path.join(directory,'task')});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(12000);
  const result={directory,checks:[],errors:[]};page.on('pageerror',error=>result.errors.push(error.message));
  const state=()=>fetch(app.url+'/api/workbench/state').then(r=>r.json());
  const list=page.getByTestId('node-content-panel');const row=id=>list.locator(`[data-content-node-id="${id}"]`);
  const form=()=>page.getByTestId('content-composer');const input=()=>form().getByLabel('补充原话',{exact:true});
  const choose=async id=>{if(!(await page.getByTestId(`directory-node-${id}`).isVisible()))await page.getByTestId('directory-toggle').click();await page.getByTestId(`directory-node-${id}`).click();await expect(page.getByTestId('node-workspace')).toHaveAttribute('data-current-node-id',id);};
  const resume=async id=>{await choose(id);if(!(await form().isVisible()))await row(id).getByRole('button',{name:'继续未保存的补充',exact:true}).click();};
  const check=name=>result.checks.push(name);
  let release;
  try{
    await page.goto(app.url);await expect(page.getByTestId('workspace-node-title')).toHaveText('校验降幅');
    const initial=await state();await expect(list).toBeVisible();await expect(page.getByRole('group',{name:'工作形态'})).toHaveCount(0);await page.getByTestId('view-graph').click();
    check('Legacy read-mode task restores its saved primary content view without mode gating');
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-busy','false');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
    await page.getByRole('button',{name:'放大',exact:true}).click();
    await page.waitForTimeout(220);
    const transform=await page.locator('.react-flow__viewport').getAttribute('style');
    await page.getByTestId('view-content').click();
    await expect(row('validate')).toHaveAttribute('data-selected','true');
    await expect(list.locator('[data-content-node-id]')).toHaveCount(1);
    await expect(page.getByTestId('directory-node-validate')).toHaveAttribute('aria-current','page');
    const prose=row('validate').getByTestId('node-prose-validate');
    await expect(prose.locator('[data-node-section="actions"] .structured-claim-text')).toHaveText([initial.model.claims.find(c=>c.id==='validate-actions').text,extraAction.text]);
    await expect(page.getByTestId('node-inspector')).toHaveCount(0);
    await expect(prose.locator('[data-node-section="supplemental"] .structured-claim-text')).toHaveText(initial.model.claims.find(c=>c.id==='validate-rules').text);
    await expect(row('validate').locator('.source-material-text').first()).toBeHidden();
    await expect(prose.locator('.claim-evidence')).toHaveCount(0);
    const evidence=row('validate').locator('.source-material').first();await evidence.locator('summary').click();
    const quote=await evidence.locator('.source-material-text').textContent();const sourceId=await evidence.getAttribute('data-source-id');const start=Number(await evidence.getAttribute('data-start-line')),end=Number(await evidence.getAttribute('data-end-line'));
    assert.equal(quote,initial.model.sources.find(source=>source.id===sourceId).text.split('\n').slice(start-1,end).join('\n'));

    await expect(page.getByTestId('node-workspace')).toBeVisible();
    await page.getByTestId('view-graph').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),transform);
    check('Graph/list round trip retains a deliberately changed viewport and selected node');

    await page.getByTestId('view-content').click();
    await page.getByTestId('directory-scope').selectOption('all');
    await expect(page.getByTestId('node-directory').locator('.directory-node')).toHaveCount(initial.model.nodes.length);
    const workspace=page.getByTestId('node-workspace-scroll');
    if(!(await evidence.evaluate(element=>element.open)))await evidence.locator('summary').click();
    const readingTop=await workspace.evaluate(element=>{element.scrollTop=Math.min(280,element.scrollHeight-element.clientHeight);return element.scrollTop;});
    assert.ok(readingTop>0,'long node fixture must permit restoring a real reading offset');
    await choose('manual');
    await expect(row('validate')).toHaveCount(0);
    await expect(page.getByTestId('workspace-node-title')).toHaveText(initial.model.nodes.find(n=>n.id==='manual').title);
    await expect(row('manual').locator('[data-node-section="actions"]')).toContainText('资料未说明操作');
    await expect(row('manual')).not.toContainText('0 条操作');
    check('Wide current result shows every adopted action, supplemental claims and explicit unknown operations');
    await page.getByTestId('navigation-back').click();
    await expect(row('validate')).toBeVisible();
    await expect(evidence).toHaveAttribute('open','');
    await expect.poll(()=>workspace.evaluate(element=>element.scrollTop)).toBe(readingTop);
    await expect(page.getByTestId('directory-scope')).toHaveValue('all');
    await choose('manual');
    await row('manual').getByTestId('refine-node-materials').click();
    await expect(page.getByTestId('agent-task-targets')).toContainText(initial.model.nodes.find(n=>n.id==='manual').title);
    await expect(page.getByTestId('agent-task-targets')).not.toContainText('校验降幅');
    await page.getByTestId('cancel-agent-task').click();
    await expect(row('manual').getByTestId('refine-node-materials')).toBeFocused();
    check('Full directory exposes every node; Back restores reading and disclosures, and regeneration follows the selected node');

    await choose('validate');
    await row('validate').getByTestId('add-content-note').click();await input().fill('A节点未保存的原话。');
    await choose('manual');
    await row('manual').getByTestId('add-content-note').click();
    await expect(form()).toHaveAttribute('data-editor-node-id','manual');await expect(input()).toHaveValue('');await input().fill('B节点未保存的原话。');
    await resume('validate');await expect(input()).toHaveValue('A节点未保存的原话。');
    await resume('manual');await expect(input()).toHaveValue('B节点未保存的原话。');
    await page.reload();await expect(form()).toHaveAttribute('data-editor-node-id','manual');await expect(input()).toHaveValue('B节点未保存的原话。');
    await expect(row('validate')).toHaveCount(0);
    await resume('validate');await expect(input()).toHaveValue('A节点未保存的原话。');
    check('Two node drafts and the single active editor identity survive directory navigation and refresh');

    let arrived;const applied=new Promise(resolve=>arrived=resolve);const held=new Promise(resolve=>release=resolve);
    await page.route('**/api/workbench/content',async route=>{const response=await route.fetch();arrived();await held;await route.fulfill({response});},{times:1});
    await form().getByTestId('save-content').click();await applied;
    await resume('manual');await input().fill('B在A保存期间继续输入。');
    release();await expect.poll(async()=>(await state()).contentTree.entries.some(entry=>entry.nodeId==='validate'&&entry.text==='A节点未保存的原话。')).toBe(true);
    await expect(form()).toHaveAttribute('data-editor-node-id','manual');await expect(input()).toHaveValue('B在A保存期间继续输入。');
    assert.equal((await state()).contentTree.entries.filter(e=>e.nodeId==='manual').length,0);
    await form().getByRole('button',{name:'放弃输入',exact:true}).click();
    await choose('validate');await expect(row('validate').locator('.content-entry-text')).toContainText('A节点未保存的原话。');
    check('An A save response never clears or saves B input typed while that response was delayed');

    const target=initial.model.nodes.find(n=>n.id==='calculate');
    await page.getByTestId('directory-search').fill(target.title);await choose(target.id);
    await expect(row(target.id)).toHaveAttribute('data-selected','true');await expect(page.getByTestId('directory-scope')).toHaveValue('all');
    await expect(page.getByTestId('directory-search')).toHaveValue(target.title);
    await page.getByTestId('directory-search').fill('');
    await expect(page.getByTestId('node-directory').locator('.directory-node')).toHaveCount(initial.model.nodes.length);
    await row(target.id).getByTestId('add-content-note').click();
    await input().fill('仅此节点未提交材料');
    await page.getByTestId('view-graph').click();await expect(page.getByTestId('node-title')).toHaveValue(target.title);await expect(page.getByTestId('quick-content')).toHaveCount(0);
    await page.getByTestId('view-content').click();await expect(input()).toHaveValue('仅此节点未提交材料');
    await form().getByRole('button',{name:'放弃输入',exact:true}).click();

    assert.equal((await state()).modelHash,initial.modelHash);
    check('Directory search keeps its context and full-flow access; cross-group materials remain isolated from results');

    await page.screenshot({path:path.join(directory,'01-list-desktop.png'),fullPage:false});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(directory,'02-list-narrow.png'),fullPage:false});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await choose('validate');await row('validate').getByTestId('add-content-note').click();await expect(form()).toHaveAttribute('data-editor-node-id','validate');
    await input().fill('窄屏列表输入。');
    await page.getByTestId('view-graph').click();await expect(page.getByTestId('quick-content')).toHaveCount(0);await page.getByTestId('organize-node').click();await expect(input()).toHaveValue('窄屏列表输入。');
    check('390px directory and workspace do not overflow; isolated material drafts survive graph/content navigation');
    assert.deepEqual(result.errors,[]);result.passed=true;
  }catch(error){result.failure=error.stack||String(error);result.passed=false;await page.screenshot({path:path.join(directory,'failure.png'),fullPage:false}).catch(()=>{});}
  finally{if(release)release();fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.resolve('.qa/workbench-content-list-browser/latest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();await app.close();if(!result.passed)process.exitCode=1;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
