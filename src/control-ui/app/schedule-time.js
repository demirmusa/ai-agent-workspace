'use strict';
// Dates and times of scheduled tasks and schedules: local input values, display and countdowns.
// Scheduling. A ready task with a future start time waits for it; a schedule creates a ready task at each occurrence.
function localDateTimeValue(value){if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';const pad=number=>String(number).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;}
function isoFromLocal(value){if(!value)return null;const time=new Date(value).getTime();if(!Number.isFinite(time))throw new Error(globalThis.AIWSI18n.text('Geçerli bir tarih ve saat gir.'));return new Date(time).toISOString();}
function scheduleTime(value,timeZone){if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';try{return date.toLocaleString(globalThis.AIWSI18n.locale,{dateStyle:'medium',timeStyle:'short',...(timeZone?{timeZone}:{})});}catch{return date.toLocaleString(globalThis.AIWSI18n.locale,{dateStyle:'medium',timeStyle:'short'});}}
const scheduledWaiting=item=>['backlog','ready'].includes(item.status)&&Boolean(item.scheduledAt)&&Date.parse(item.scheduledAt)>Date.now();
function untilText(value){const t=globalThis.AIWSI18n.text,minutes=Math.round((Date.parse(value)-Date.now())/60000);if(!Number.isFinite(minutes))return '';if(minutes<1)return t('şimdi');if(minutes<60)return `${minutes} ${t('dk sonra')}`;if(minutes<2880)return `${Math.round(minutes/60)} ${t('sa sonra')}`;return `${Math.round(minutes/1440)} ${t('gün sonra')}`;}
const weekdayName=day=>new Intl.DateTimeFormat(globalThis.AIWSI18n.locale,{weekday:'short',timeZone:'UTC'}).format(new Date(Date.UTC(2023,0,1+day,12)));
