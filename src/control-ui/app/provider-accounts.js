'use strict';
// Provider accounts: several logins of one provider (Claude Code through claude-swap) for tasks, terminals and quota.
// The server drives the account manager; this file keeps its listing, draws the settings section and fills every account select.
const providerAccounts={};
function providerAccountState(provider){return providerAccounts[provider]??={status:null,loading:null,error:'',busy:''};}
function loadProviderAccounts(provider,refresh=false){
  const entry=providerAccountState(provider);if(entry.loading&&!refresh)return entry.loading;
  const request=entry.loading=api(`/providers/${encodeURIComponent(provider)}/accounts${refresh?'?refresh=1':''}`).then(status=>{if(entry.loading===request){entry.status=status;entry.error='';}}).catch(cause=>{if(entry.loading===request)entry.error=cause.message;}).finally(()=>{if(entry.loading===request)entry.loading=null;renderProviderAccounts();});
  renderProviderAccounts();return request;
}
/** A provider's listed accounts; the first call loads them. */
function providerAccountList(provider){
  if(!accountProviders.includes(provider))return [];
  const entry=providerAccountState(provider);if(!entry.status&&!entry.loading&&!entry.error)void loadProviderAccounts(provider);
  return entry.status?.accounts||[];
}
function providerAccountLabel(provider,id){return providerAccountList(provider).find(account=>account.id===id)?.label||`#${id}`;}
/** Options of an account select: the default login first, then each account; a chosen account that is gone stays listed. */
function providerAccountOptions(provider,value=''){
  const t=globalThis.AIWSI18n.text,accounts=providerAccountList(provider),option=(id,label,selected)=>`<option value="${esc(id)}" ${selected?'selected':''}>${esc(label)}</option>`;
  return [option('',t('Varsayılan giriş'),!value),...accounts.map(account=>option(account.id,account.active?`${account.label} · ${t('Varsayılan giriş')}`:account.label,account.id===value)),...(value&&!accounts.some(account=>account.id===value)?[option(value,`#${value}`,true)]:[])].join('');
}
/** A form offers the account choice once the provider has several accounts to pick from, or the task already names one. */
function providerAccountsShown(provider,value=''){return accountProviders.includes(provider)&&(Boolean(value)||providerAccountList(provider).length>1);}
/** Refills an account select (data-account-provider, data-value) after the accounts or its provider changed. */
function syncAccountSelect(select){
  const provider=select.dataset.accountProvider||'',value=accountProviders.includes(provider)?select.dataset.value||'':'';
  setHtml(select,providerAccountOptions(provider,value));select.value=value;
  const field=select.closest('[data-account-field]');if(field)field.hidden=!providerAccountsShown(provider,value);
}
/** The account field of a task form; bindAccountField keeps it on the provider the form will run. */
function accountFieldMarkup(provider,value=''){
  const t=globalThis.AIWSI18n.text;
  return `<div class="form-field" data-account-field ${providerAccountsShown(provider,value)?'':'hidden'}><label for="field-account">${esc(t('Hesap'))}</label><select id="field-account" name="account" data-account-provider="${esc(provider)}" data-value="${esc(value)}">${providerAccountOptions(provider,value)}</select><small>${esc(t('Görev bu hesapla ve onun kotasıyla çalışır.'))}</small></div>`;
}
/** Follows the form's provider choice (its provider, else its agent's, else the default); another provider clears the account. */
function bindAccountField(form,effectiveProvider){
  const select=form.querySelector('select[data-account-provider]');if(!select)return;
  const sync=()=>{const provider=effectiveProvider();if(select.dataset.accountProvider!==provider){select.dataset.accountProvider=provider;select.dataset.value='';}syncAccountSelect(select);};
  form.addEventListener('change',event=>{if(event.target===select)select.dataset.value=select.value;else sync();});
  form.addEventListener('agentpickerchange',sync);
}
/** Redraws everything that shows accounts: the settings sections, account selects and open terminal menus. */
function renderProviderAccounts(){
  for(const element of document.querySelectorAll('[data-provider-accounts]'))setHtml(element,providerAccountsMarkup(element.dataset.providerAccounts));
  for(const select of document.querySelectorAll('select[data-account-provider]'))syncAccountSelect(select);
  refreshTerminalMenus();
}
/** A settings section per provider with accounts; the work settings only, since accounts belong to this machine. */
function providerAccountsSectionMarkup(){
  const t=globalThis.AIWSI18n.text;
  return accountProviders.map(provider=>`<section class="settings-section" aria-labelledby="settings-accounts-${provider}-title"><header class="settings-section-header" data-motion-key="settings:accounts:${provider}"><div><h2 id="settings-accounts-${provider}-title">${esc(providers[provider])} · ${esc(t('Hesaplar'))}</h2><p>${esc(t('Birden fazla hesabı aynı anda kullan: her görev ve terminal seçtiğin hesapla ve o hesabın kotasıyla çalışır. Hesapları claude-swap tutar; AIWS onu kurar ve senin yerine kullanır.'))}</p></div><div class="settings-section-actions"><button type="button" class="button small" data-accounts-refresh="${provider}"><span class="button-glyph" aria-hidden="true">↻</span> ${esc(t('Yenile'))}</button></div></header><div class="provider-accounts" data-provider-accounts="${provider}"></div></section>`).join('');
}
function providerAccountsMarkup(provider){
  const t=globalThis.AIWSI18n.text,pill=window.AIWSUI.statusPill,entry=providerAccountState(provider),status=entry.status,busy=entry.busy;
  if(!status&&!entry.loading&&!entry.error)void loadProviderAccounts(provider);
  if(!status)return `<p class="provider-accounts-note">${entry.error?`${pill('failed',t('Hesaplar alınamadı'))}<span>${esc(entry.error)}</span>`:pill('running',t('Hesaplar okunuyor…'))}</p>`;
  const tool=status.tool,spinner=key=>busy===key?'<span class="ui-spinner" aria-hidden="true"></span>':'',link=`<a class="help-link" href="${esc(safeLink(tool.url))}" target="_blank" rel="noreferrer">${esc(tool.name)} ↗</a>`;
  if(!tool.installed)return `<div class="provider-accounts-setup ui-card"><div class="provider-accounts-setup-text"><strong>${esc(t('Hesap yöneticisi kurulu değil'))}</strong><p>${esc(tool.installer?t('claude-swap hesapları saklar, her hesaba ayrı bir Claude Code profili açar ve kotalarını okur. Kur düğmesi onu bu bilgisayara kurar.'):t('claude-swap uv veya pipx ile kurulur. Önce uv kur (https://docs.astral.sh/uv/), sonra Yenile.'))}</p>${link}</div><button type="button" class="button primary small" data-accounts-install="${provider}" ${busy||!tool.installer?'disabled':''} aria-busy="${busy==='install'}">${spinner('install')}${esc(busy==='install'?t('Kuruluyor…'):t('claude-swap kur'))}</button></div>`;
  const rows=status.accounts.map(account=>providerAccountRow(provider,account,busy)).join('');
  return `<div class="provider-accounts-bar">${pill('done',t('claude-swap kurulu'))}${link}<span class="provider-accounts-actions"><button type="button" class="button small" data-accounts-current="${provider}" ${busy?'disabled':''} title="${esc(t('Claude Code’un şu anki girişini hesap olarak ekler'))}">${spinner('current')}${esc(t('Mevcut girişi ekle'))}</button><button type="button" class="button small primary" data-accounts-login="${provider}" title="${esc(t('Ayrı profilde Claude Code açar; giriş yapınca hesap otomatik eklenir'))}">+ ${esc(t('Hesap ekle'))}</button></span></div>${status.error?`<p class="form-error">${esc(status.error)}</p>`:''}${rows?`<ul class="provider-account-list">${rows}</ul>`:`<p class="settings-empty">${esc(t('Henüz hesap yok. Hesap ekle bir terminal açar: orada giriş yap, hesap otomatik eklenir. Mevcut girişi ekle şu anki Claude Code hesabını ekler.'))}</p>`}<p class="form-hint">${esc(t('Görev formundaki Hesap alanından veya terminal menüsünden istediğin hesabı seç. Varsayılan giriş dışındaki her hesabın kotası, kota penceresinde ayrı bir kartta görünür.'))}</p>`;
}
const providerAccountStates={relogin_required:'Yeniden giriş gerekli',token_expired:'Token yenilenmeyi bekliyor',api_key:'API anahtarı',no_credentials:'Giriş bilgisi yok',keychain_unavailable:'Anahtar zinciri okunamadı',foreign_credential:'Başka hesabın girişi'};
function providerAccountRow(provider,account,busy){
  const t=globalThis.AIWSI18n.text,pill=window.AIWSUI.statusPill,problem=providerAccountStates[account.status];
  const windows=[account.short,account.weekly].map(window=>{const used=tokenUsed(window),reset=tokenReset(window);return `<span class="provider-account-window"><small>${esc(tokenWindowLabel(window.windowMinutes))}</small><b${tokenTone(used)?` data-tone="${tokenTone(used)}"`:''}>${tokenPercent(tokenRemaining(window))}</b>${reset?`<small>${esc(reset)}</small>`:''}</span>`;}).join('');
  const detail=[account.alias?account.email:'',account.organization].filter(Boolean).join(' · ');
  return `<li class="provider-account ui-card" data-account="${esc(account.id)}"><span class="provider-account-number" aria-hidden="true">${esc(account.id)}</span><span class="provider-account-name"><strong title="${esc(account.email)}">${esc(account.label)}</strong>${detail?`<small>${esc(detail)}</small>`:''}<span class="provider-account-chips">${account.active?`<span class="ui-chip is-accent">${esc(t('Varsayılan giriş'))}</span>`:''}${account.disabled?`<span class="ui-chip">${esc(t('Rotasyon dışı'))}</span>`:''}${problem?pill('needs',t(problem)):''}</span></span><span class="provider-account-usage" role="group" aria-label="${esc(t('Kalan kota'))}">${windows}</span><span class="provider-account-actions"><button type="button" class="button small" data-accounts-terminal="${provider}:${esc(account.id)}">${esc(t('Terminal aç'))}</button><button type="button" class="button small ghost danger" data-accounts-remove="${provider}:${esc(account.id)}" ${busy?'disabled':''} aria-label="${esc(`${t('Kaldır')}: ${account.label}`)}">${esc(t('Kaldır'))}</button></span></li>`;
}
async function changeProviderAccounts(provider,busy,request,done=''){
  const entry=providerAccountState(provider);if(entry.busy)return;entry.busy=busy;renderProviderAccounts();
  try{entry.status=await request();entry.error='';if(done)toast(done);}catch(cause){toast(cause.message);}finally{entry.busy='';renderProviderAccounts();}
}
/** Opens a terminal in the current project (else the general workspace) and shows its Terminal tab. */
function openProviderTerminal(spec){
  const target=projectId&&(isGeneralProject(projectId)||state.projects.some(item=>item.id===projectId))?projectId:state.generalWorkspace?.id;
  if(!target){toast(globalThis.AIWSI18n.text('Terminal açmak için önce bir proje seç.'));return;}
  localStorage.setItem(`aiws.project-tab.${target}`,'terminal');
  if(isGeneralProject(target))openGeneralWorkspace();else openProject(target);
  void openProjectTerminal(target,spec);
}
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-accounts-refresh],[data-accounts-install],[data-accounts-current],[data-accounts-login],[data-accounts-terminal],[data-accounts-remove]');if(!target||target.disabled)return;
  const t=globalThis.AIWSI18n.text,data=target.dataset,path=provider=>`/providers/${encodeURIComponent(provider)}/accounts`;
  if(data.accountsRefresh){void loadProviderAccounts(data.accountsRefresh,true);return;}
  if(data.accountsInstall){void changeProviderAccounts(data.accountsInstall,'install',()=>api(`${path(data.accountsInstall)}/install`,'POST',{}),t('claude-swap kuruldu'));return;}
  if(data.accountsCurrent){void changeProviderAccounts(data.accountsCurrent,'current',()=>api(`${path(data.accountsCurrent)}/current`,'POST',{}),t('Mevcut giriş eklendi'));return;}
  if(data.accountsLogin){openProviderTerminal({kind:'login',provider:data.accountsLogin});return;}
  const [provider,account]=(data.accountsTerminal||data.accountsRemove).split(':');
  if(data.accountsTerminal){openProviderTerminal({kind:'agent',provider,account});return;}
  if(!await confirmModal(t('Hesap kaldırılsın mı?'),`${providerAccountLabel(provider,account)} · ${t('Hesap claude-swap’ten kaldırılsın mı? Yeniden kullanmak için tekrar giriş yapman gerekir.')}`,{confirmLabel:t('Hesabı kaldır'),danger:true}))return;
  void changeProviderAccounts(provider,'remove',()=>api(`${path(provider)}/${encodeURIComponent(account)}`,'DELETE'),t('Hesap kaldırıldı'));
});
