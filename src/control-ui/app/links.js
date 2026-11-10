'use strict';
// External links: only http(s) URLs become links, so server or provider data never yields a javascript: href.
function safeLink(url) { try { const parsed=new URL(url); return ['https:','http:'].includes(parsed.protocol)?parsed.href:'#'; } catch {return '#';} }
function pullRequestLink(pull,className=''){return pull?.url?`<a${className?` class="${esc(className)}"`:''} href="${esc(safeLink(pull.url))}" target="_blank" rel="noreferrer">PR #${esc(pull.number)} ↗</a>`:'';}
