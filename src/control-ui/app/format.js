'use strict';
// Date, time, duration and id formatting.
/** A date and time in the interface locale; options are Intl.DateTimeFormat options. */
// Formatters are costly to build and timers format every second, so each option set keeps one; options without a date or
// time field show both, as toLocaleString does.
const dateTimeFormats=new Map(),dateTimeFields=['weekday','era','year','month','day','dayPeriod','hour','minute','second','fractionalSecondDigits','dateStyle','timeStyle'];
function dateTime(value,options) {
  const date=new Date(value);if(Number.isNaN(date.getTime()))return 'Invalid Date';
  const key=options?JSON.stringify(options):'';let format=dateTimeFormats.get(key);
  if(!format){const complete=options&&dateTimeFields.some(field=>field in options)?options:{year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',...options};format=new Intl.DateTimeFormat(globalThis.AIWSI18n.locale,complete);dateTimeFormats.set(key,format);}
  return format.format(date);
}
const timeFormat=new Intl.DateTimeFormat(globalThis.AIWSI18n.locale,{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function time(value) { return value ? timeFormat.format(new Date(value)) : ''; }
function relative(value) { const minutes = Math.max(0, Math.round((Date.now()-new Date(value).getTime())/60000)); return minutes < 1 ? globalThis.AIWSI18n.text('şimdi') : minutes < 60 ? globalThis.AIWSI18n.template`${minutes} dk` : minutes < 1440 ? globalThis.AIWSI18n.template`${Math.round(minutes/60)} sa` : globalThis.AIWSI18n.template`${Math.round(minutes/1440)} gün`; }
/** Time since a moment in its largest whole unit, e.g. "5 dk önce". */
function agoShort(value){
  const t=globalThis.AIWSI18n.text,seconds=Math.max(1,Math.floor((Date.now()-new Date(value).getTime())/1000));
  const [amount,unit]=seconds<60?[seconds,'sn']:seconds<3600?[Math.floor(seconds/60),'dk']:seconds<86400?[Math.floor(seconds/3600),'sa']:[Math.floor(seconds/86400),'gün'];
  return `${amount} ${t(unit)} ${t('önce')}`;
}
/** Whole seconds as m:ss, or h:mm:ss from an hour on. */
function clockDuration(seconds){return seconds>=3600?`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
/** The short readable part of a generated id, e.g. task_ab12cd… → AB12CD. */
function shortId(id) { return String(id).replace(/^[a-z]+[_-]/i,'').slice(0,6).toUpperCase(); }
/** The key of a local task: AIWS- and its short id. */
const localTaskKey=id=>`AIWS-${shortId(id)}`;
/** The key a task is known by: its GitHub issue number, else its local key. */
const taskKey=item=>item.github?.issueNumber?`#${item.github.issueNumber}`:localTaskKey(item.id);
