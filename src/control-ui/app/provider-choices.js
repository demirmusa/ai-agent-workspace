'use strict';
// Provider choices for task, agent and schedule forms, and the command provider's fields.
/** Provider choices for task and agent forms: enabled built-ins, the generic command, enabled custom presets; a saved choice stays visible. */
/** The one list of built-in providers every picker offers: disabled ones stay visible, marked and not selectable. */
function providerChoices(selected){return Object.keys(providers).filter(value=>value!=='command').map(id=>({id,name:providers[id],enabled:providerEnabled(id),selectable:providerEnabled(id)||id===selected}));}
/** The picker's provider options: built-ins, then the generic command and enabled custom presets where the activeScreen can run them. */
function providerOptions(selected,{command=true,custom=true}={}){return [...providerChoices(selected).map(({id,name,enabled,selectable})=>`<option value="${esc(id)}" ${selected===id?'selected':''}${selectable?'':' disabled'}>${esc(name)}${enabled?'':globalThis.AIWSI18n.text(' · kapalı')}</option>`),...(command&&providers.command?[`<option value="command" ${selected==='command'?'selected':''}>${esc(providers.command)}</option>`]:[])].join('')+(custom?enabledCustomProviders().map(item=>`<option value="custom:${esc(item.id)}">${esc(item.name)}${globalThis.AIWSI18n.text(' · özel')}</option>`).join(''):'');}
function providerChoice(value,data){if(!String(value).startsWith('custom:'))return {provider:value,command:value==='command'?parseCommand(data):null};const custom=(projectProviderSettings().customProviders||[]).find(item=>`custom:${item.id}`===value);if(!custom)throw new Error(globalThis.AIWSI18n.text('Seçilen özel sağlayıcı artık yok. Çalışma ayarlarını kontrol et.'));return {provider:'command',command:{executable:custom.executable,args:[...custom.args]}};}
const providerEnabled=provider=>!(projectProviderSettings().disabledProviders||[]).includes(provider);
const enabledCustomProviders=()=>(projectProviderSettings().customProviders||[]).filter(item=>item.enabled!==false);
function commandFields(command) {
  return globalThis.AIWSI18n.template`${field(globalThis.AIWSI18n.text('Çalıştırılacak program'),'executable',command?.executable||'','text','placeholder="node"')}${field(globalThis.AIWSI18n.text('Argümanlar (JSON dizisi)'),'args',JSON.stringify(command?.args||[]),'text',`placeholder='["scripts/agent.mjs"]'`)}<p class="form-hint">Program shell olmadan çalışır. Görev ve skill bilgileri ortam değişkenleriyle sağlanır.</p>`;
}
function parseCommand(data) {
  let args; try {args=JSON.parse(String(data.get('args'))||'[]');} catch {throw new Error(globalThis.AIWSI18n.text('Argümanları JSON dizisi olarak gir. Örnek: ["script.mjs"]'));}
  const executable=String(data.get('executable')||'').trim();
  if(!executable||!Array.isArray(args)||args.some(value=>typeof value!=='string')) throw new Error(globalThis.AIWSI18n.text('Program ve metinlerden oluşan bir argüman dizisi gerekli.'));
  return {executable,args};
}
