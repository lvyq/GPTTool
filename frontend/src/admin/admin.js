const apiBase='../api/admin';
const $=(selector)=>document.querySelector(selector);
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let config={};
let editingRule;

$('#adminLoginForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;$('#adminLoginError').textContent='';try{await loginRequest();await enterAdmin()}catch(error){$('#adminLoginError').textContent=error.message}finally{button.disabled=false}});

document.querySelectorAll('[data-page]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.page)));
$('#refreshOverview').addEventListener('click',loadOverview);
$('#userSearch').addEventListener('input',debounce(loadUsers,250));
$('#newRule').addEventListener('click',()=>openRuleEditor());
$('#refreshRules').addEventListener('click',loadRules);
$('#ruleFile').addEventListener('change',async(event)=>{const file=event.target.files[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('规则文件不能超过 1 MB');const rules=JSON.parse(await file.text());$('#ruleJson').value=JSON.stringify(rules,null,2);$('#rulePlatform').value=rules.collector?.validation?.platform||'darwin';$('#ruleError').textContent='';}catch(error){$('#ruleError').textContent=error.message}finally{event.target.value=''}});
$('#saveRule').addEventListener('click',saveRule);
$('#saveConfig').addEventListener('click',saveConfig);

async function showPage(name){document.querySelectorAll('[data-page]').forEach((button)=>button.classList.toggle('active',button.dataset.page===name));document.querySelectorAll('.page').forEach((page)=>page.classList.toggle('active',page.id===`page-${name}`));if(name==='users')await loadUsers();if(name==='rules')await loadRules();if(name==='config')await loadConfig();}
async function request(path,options={}){const response=await fetch(`${apiBase}${path}`,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(response.status===401){showAdminLogin();throw new Error('请使用管理员账号登录')}if(!response.ok)throw new Error(body.error||`HTTP ${response.status}`);return body;}
async function loginRequest(){const response=await fetch('../api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#adminUsername').value,password:$('#adminPassword').value})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||`HTTP ${response.status}`);$('#adminPassword').value='';return body}
async function enterAdmin(){await request('/overview');$('#adminLogin').classList.add('hidden');$('#adminApp').classList.remove('hidden');await loadOverview()}
function showAdminLogin(){if($('#adminLogin'))$('#adminLogin').classList.remove('hidden');if($('#adminApp'))$('#adminApp').classList.add('hidden')}
async function loadOverview(){try{const [data,series]=await Promise.all([request('/overview'),request('/metrics?hours=24')]);const cards=[['用户总量',data.users,'过去 24 小时新增 '+data.registrations24h],['当前在线用户',data.onlineUsers,'按在线设备账号去重'],['在线设备',data.onlineDevices,'已绑定设备 '+data.devices],['活跃控制页面',data.activeBrowsers,'有效会话 '+data.sessions],['CDP 规则',data.cdpRules?.enabled||0,'规则总量 '+(data.cdpRules?.total||0)],['队列快照',data.queuedSnapshots,'PostgreSQL 持久化'],['存储引擎',String(data.service?.storage||'-').toUpperCase(),'运行 '+duration(data.service?.uptimeSeconds)],['启用用户',data.enabledUsers,'禁用 '+(data.users-data.enabledUsers)]];$('#metrics').innerHTML=cards.map(([label,value,note])=>`<article class="metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></article>`).join('');renderChart(series.metrics||[]);}catch(error){notify(error.message,true)}}
function renderChart(series){if(!series.length){$('#chart').innerHTML='<p>等待第一批统计采样…</p>';return}const max=Math.max(1,...series.map((item)=>item.onlineUsers));$('#chart').innerHTML=series.map((item)=>`<i class="bar" style="height:${Math.max(3,item.onlineUsers/max*100)}%" title="${new Date(item.sampledAt).toLocaleString()} · ${item.onlineUsers} 人"></i>`).join('')}
async function loadUsers(){try{const data=await request(`/users?q=${encodeURIComponent($('#userSearch').value)}`);$('#usersTable').innerHTML='<div class="table-row header"><span>账号</span><span>状态</span><span>角色</span><span>设备</span><span>操作</span></div>'+data.users.map((user)=>`<div class="table-row"><span><strong>${escapeHtml(user.username)}</strong><small>${new Date(user.createdAt).toLocaleDateString()}</small></span><span class="status ${user.online?'online':''}">${user.disabled?'已禁用':user.online?'在线':'离线'}</span><span>${user.role==='admin'?'管理员':'用户'}</span><span>${user.deviceCount} 台</span><span class="actions">${user.username==='admin'?'系统管理员':`<button data-user="${user.id}" data-action="role">${user.role==='admin'?'取消管理':'设为管理'}</button><button class="danger" data-user="${user.id}" data-action="disabled">${user.disabled?'启用':'禁用'}</button>`}</span></div>`).join('');$('#usersTable').querySelectorAll('button').forEach((button)=>button.addEventListener('click',()=>updateUser(button)));}catch(error){notify(error.message,true)}}
async function updateUser(button){const row=button.closest('.table-row');const role=row.children[2].textContent==='管理员'?'admin':'user';const disabled=row.children[1].textContent==='已禁用';const changes=button.dataset.action==='role'?{role:role==='admin'?'user':'admin'}:{disabled:!disabled};try{await request(`/users/${button.dataset.user}`,{method:'PATCH',body:JSON.stringify(changes)});notify('用户状态已更新');loadUsers()}catch(error){notify(error.message,true)}}
async function loadRules(){
  try{
    const {rules=[]}=await request('/cdp-rules');
    $('#rulesTable').innerHTML=rules.length ? rules.map(rule=>{
      const validated=rule.validation?.status==='passed';
      return `<article class="rule-card"><div class="rule-card-heading"><div><strong>${escapeHtml(rule.id)}</strong><span>${escapeHtml(versionRange(rule))} · ${escapeHtml(rule.platform)}</span></div><span class="status ${rule.enabled?'online':''}">${rule.enabled?'已启用':'已停用'}</span></div><dl class="rule-facts"><div><dt>上传时间</dt><dd>${formatRuleTime(rule.uploadedAt)}</dd></div><div><dt>最后编辑</dt><dd>${formatRuleTime(rule.updatedAt)}</dd></div><div><dt>优先级</dt><dd>${rule.priority===2147483647?'最高 · 验证规则':escapeHtml(rule.priority)}</dd></div><div><dt>功能验证</dt><dd>${validated?'通过 · '+formatRuleTime(rule.validation.validatedAt):'旧规则 · 尚无实测报告'}</dd></div></dl><details><summary>验证明细</summary><p>${validated?'报告与规则内容绑定，修改操作规则后必须重新实测。':'历史规则保留原启用状态；重新上传或启用前需通过新版采集器验证。旧数据未记录独立上传时间时显示为“未记录”。'}</p><ul>${Object.entries(rule.validation?.checks||{}).map(([name,check])=>`<li>${escapeHtml(name)}：${escapeHtml(check.status)} ${escapeHtml(check.message||'')}</li>`).join('')}</ul></details><div class="actions"><button data-id="${escapeHtml(rule.id)}" data-action="edit">编辑</button><button data-id="${escapeHtml(rule.id)}" data-action="toggle">${rule.enabled?'停用':'启用'}</button><button class="danger" data-id="${escapeHtml(rule.id)}" data-action="delete">删除</button></div></article>`;
    }).join('') : '<p class="rules-empty">暂无规则。请上传采集器实测通过的规则包。</p>';
    $('#rulesTable').querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>changeRule(button,rules)));
  }catch(error){notify(error.message,true)}
}
function formatRuleTime(value){if(!value)return '未记录';const date=new Date(value);return Number.isFinite(date.getTime())?escapeHtml(date.toLocaleString('zh-CN',{hour12:false})):'未记录';}
function openRuleEditor(rule){
  editingRule=rule;
  $('#ruleDialogTitle').textContent=rule?'编辑兼容规则':'上传已验证规则';
  $('#ruleJson').value=rule?JSON.stringify(rule.payload,null,2):'';
  $('#rulePlatform').value=rule?.platform||'darwin';
  $('#rulePriority').value=rule?.priority??2147483647;
  $('#rulePriority').disabled=!rule;
  $('#ruleError').textContent='';
  $('#saveRule').textContent=rule?'保存修改':'验证并上传至最高优先级';
  $('#ruleDialog').showModal();
}
async function changeRule(button,rules){
  const rule=rules.find(item=>item.id===button.dataset.id);if(!rule)return;
  if(button.dataset.action==='edit'){openRuleEditor(rule);return}
  if(button.dataset.action==='delete'&&!confirm(`永久删除规则 ${rule.id}？客户端可能回退到缓存或内置规则，已下载缓存不会被远程擦除。`))return;
  button.disabled=true;
  try{
    await request(`/cdp-rules/${encodeURIComponent(rule.id)}`,button.dataset.action==='delete'?{method:'DELETE'}:{method:'PATCH',body:JSON.stringify({enabled:!rule.enabled})});
    notify('规则已更新');await loadRules();
  }catch(error){notify(error.message,true)}finally{button.disabled=false}
}
async function saveRule(){
  const button=$('#saveRule');if(button.disabled)return;button.disabled=true;
  try{
    const rules=JSON.parse($('#ruleJson').value),platform=$('#rulePlatform').value;
    if(editingRule){
      if(rules.id!==editingRule.id)throw new Error('编辑不能更改规则 ID');
      const changes={priority:Number($('#rulePriority').value)};
      if(platform!==editingRule.platform)changes.platform=platform;
      if(JSON.stringify(rules)!==JSON.stringify(editingRule.payload))changes.rules=rules;
      await request(`/cdp-rules/${encodeURIComponent(editingRule.id)}`,{method:'PATCH',body:JSON.stringify(changes)});
    }else await request('/cdp-rules',{method:'POST',body:JSON.stringify({rules,platform})});
    $('#ruleDialog').close();notify('规则已保存');await loadRules();
  }catch(error){$('#ruleError').textContent=error.message}finally{button.disabled=false}
}
async function loadConfig(){try{config=(await request('/config')).config;const controls={registrationOpen:['开放用户注册','select',[['true','开放'],['false','关闭']]],pairingTtlMinutes:['二维码有效期（分钟）','number'],sessionTtlDays:['登录会话有效期（天）','number'],maxDevicesPerUser:['单用户设备上限','number'],systemAnnouncement:['设备中心公告','text'],downloadBaseUrl:['下载/CDN 基础地址','url']};$('#configForm').innerHTML=Object.entries(controls).map(([key,[label,type,options]])=>{const item=config[key]||{};const control=type==='select'?`<select data-config="${key}">${options.map(([value,text])=>`<option value="${value}" ${String(item.value)===value?'selected':''}>${text}</option>`).join('')}</select>`:`<input data-config="${key}" type="${type}" value="${escapeHtml(item.value)}">`;return `<div class="config-item"><label>${label}</label><p>${escapeHtml(item.description||'')}</p>${control}</div>`}).join('')}catch(error){notify(error.message,true)}}
async function saveConfig(){const values={};document.querySelectorAll('[data-config]').forEach((input)=>{let value=input.value;if(input.tagName==='SELECT')value=value==='true';if(input.type==='number')value=Number(value);values[input.dataset.config]=value});try{await request('/config',{method:'PUT',body:JSON.stringify(values)});notify('系统配置已保存');loadConfig()}catch(error){notify(error.message,true)}}
function versionRange(rule){if(rule.exactVersion)return `仅 ${rule.exactVersion}`;if(rule.minVersion||rule.maxVersion)return `${rule.minVersion||'最早'} – ${rule.maxVersion||'最新'}`;return '通用兼容规则'}
function duration(seconds=0){const days=Math.floor(seconds/86400);const hours=Math.floor(seconds%86400/3600);return days?`${days} 天 ${hours} 小时`:`${hours} 小时`}
function debounce(fn,delay){let timer;return()=>{clearTimeout(timer);timer=setTimeout(fn,delay)}}
function notify(message,error=false){const toast=$('#toast');toast.textContent=message;toast.style.borderColor=error?'#7b2931':'';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2500)}
enterAdmin().catch(()=>showAdminLogin());
