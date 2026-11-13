'use strict';
// Light/dark theme: the saved or system choice and the header theme button.
const theme = localStorage.getItem('aiws.theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = theme;
// The icon names the theme the button switches to; the one that appears turns in once (header.css).
function updateThemeLabel() { const dark = document.documentElement.dataset.theme === 'dark'; const label = dark ? globalThis.AIWSI18n.text('Açık temaya geç') : globalThis.AIWSI18n.text('Koyu temaya geç'), button = $('#theme-button'); button.setAttribute('aria-label', label); button.title = label; $('#theme-icon .theme-sun').hidden = !dark; $('#theme-icon .theme-moon').hidden = dark; }
updateThemeLabel();
// The forced style pass applies the new theme while .theme-switching turns transitions off, so the whole page recolours at once.
$('#theme-button').onclick=()=>{const root=document.documentElement;root.classList.add('theme-switching');root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';void getComputedStyle(root).color;root.classList.remove('theme-switching');try{localStorage.setItem('aiws.theme',root.dataset.theme);}catch{/* Storage may be disabled. */}updateThemeLabel();};
