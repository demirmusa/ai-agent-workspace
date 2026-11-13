'use strict';
// Token use and reported cost of task runs.
/** Tokens and reported cost summed over runs; cost stays null when no run's client reported one. */
function runsUsage(list){
  const runs=list.filter(run=>run.usage);if(!runs.length)return null;
  const sum=key=>runs.reduce((total,run)=>total+run.usage[key],0),priced=runs.filter(run=>run.usage.costUsd!==null);
  return{inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),cacheReadTokens:sum('cacheReadTokens'),cacheWriteTokens:sum('cacheWriteTokens'),totalTokens:sum('totalTokens'),costUsd:priced.length?priced.reduce((total,run)=>total+run.usage.costUsd,0):null,costComplete:priced.length===runs.length};
}
const taskUsage=taskId=>derived('taskUsage',stateVersion,()=>{const byTask=new Map();for(const [id,runs] of derived('taskRuns',stateVersion,()=>groupByTask(state.runs)))byTask.set(id,runsUsage(runs));return byTask;}).get(taskId)||null;
const tokenCount=window.AIWSUI.tokenCount;
const usageCost=usage=>usage.costUsd===null?'':`$${usage.costUsd.toFixed(usage.costUsd<1?3:2)}${usage.costComplete?'':' +'}`;
const usageText=usage=>`${tokenCount(usage.totalTokens)} token${usage.costUsd===null?'':` · ${usageCost(usage)}`}`;
const usageDetail=usage=>{const t=globalThis.AIWSI18n.text;return [`${t('Girdi')}: ${AIWSUI.number(usage.inputTokens)}`,`${t('Çıktı')}: ${AIWSUI.number(usage.outputTokens)}`,usage.cacheReadTokens?`${t('Önbellek okuma')}: ${AIWSUI.number(usage.cacheReadTokens)}`:'',usage.cacheWriteTokens?`${t('Önbellek yazma')}: ${AIWSUI.number(usage.cacheWriteTokens)}`:''].filter(Boolean).join(' · ');};
function usageChip(item){const usage=taskUsage(item.id);return usage?`<span class="card-usage" title="${esc(usageDetail(usage))}">${esc(usageText(usage))}</span>`:'';}
/** Token kinds as a bar chart of their share of the total, then the reported cost; cache rows appear only when the provider reported them. */
function usageBreakdownHtml(usage){
  const t=globalThis.AIWSI18n.text,row=(label,value,kind='')=>{const share=usage.totalTokens?value/usage.totalTokens*100:0;return `<div class="usage-breakdown-row${kind?'':' is-total'}"${kind?` data-kind="${kind}"`:''}><dt>${esc(t(label))}</dt><dd><span>${esc(AIWSUI.number(value))}</span><small>${esc(tokenPercent(share))}</small></dd>${kind?`<dd class="usage-breakdown-bar" aria-hidden="true"><i style="width:${Math.min(share,100)}%"></i></dd>`:''}</div>`;};
  const cost=usage.costUsd===null?'':`<div class="usage-breakdown-row is-cost"><dt>${esc(t('Maliyet'))}</dt><dd><span>${esc(usageCost(usage))}</span></dd></div>`;
  return `<dl class="usage-breakdown">${row('Toplam token',usage.totalTokens)}${row('Girdi',usage.inputTokens,'input')}${usage.cacheReadTokens?row('Önbellek okuma',usage.cacheReadTokens,'cache-read'):''}${usage.cacheWriteTokens?row('Önbellek yazma',usage.cacheWriteTokens,'cache-write'):''}${row('Çıktı',usage.outputTokens,'output')}${cost}</dl>`;
}
/** The task's summed token use for the information sidebar; empty before any run reports usage. */
function taskUsagePanelHtml(item){
  const usage=taskUsage(item.id);if(!usage)return '';
  const t=globalThis.AIWSI18n.text,runs=state.runs.filter(run=>run.taskId===item.id&&run.usage).length;
  return `<section class="issue-panel" aria-labelledby="issue-usage-title"><header><h3 id="issue-usage-title">${esc(t('Token kullanımı'))}</h3><small class="usage-breakdown-runs">${esc(globalThis.AIWSI18n.template`${runs} çalışma`)}</small></header>${usageBreakdownHtml(usage)}</section>`;
}
