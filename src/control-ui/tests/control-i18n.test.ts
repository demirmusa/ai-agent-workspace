import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';

const asset = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const windows: Window[] = [];
function mount(language?: string) {
  const window = new Window({url:'http://localhost',settings:{disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
  windows.push(window);
  window.document.write(asset('index.html'));
  if (language) window.localStorage.setItem('aiws.language',language);
  window.eval(asset('translations-en.js')); window.eval(asset('i18n.js'));
  return {window, i18n:(window as any).AIWSI18n};
}
afterEach(async()=>{for(const window of windows.splice(0))await window.happyDOM.close();});

describe('control center language preference',()=>{
  it('defaults to Turkish and rejects unsupported saved languages',()=>{
    for(const language of [undefined,'fr','en-US']) {
      const {window,i18n}=mount(language);
      expect(i18n.language).toBe('tr'); expect(i18n.locale).toBe('tr-TR');
      expect(window.document.documentElement.lang).toBe('tr');
      expect(window.document.querySelector('#overview-nav')?.textContent).toContain('Tüm projeler');
      expect(i18n.text('Yeni görev')).toBe('Yeni görev');
    }
  });
  it('loads English shell, accessibility copy, and locale without changing language names',()=>{
    const {window,i18n}=mount('en');
    expect(window.document.documentElement.lang).toBe('en');
    expect(window.document.querySelector('#language-select')).toBeNull();
    expect(window.document.querySelector('#settings-button')?.getAttribute('aria-label')).toBe('Settings');
    expect(window.document.querySelector('#search')?.getAttribute('placeholder')).toBe('Search tasks…');
    expect(window.document.querySelector('#create-project')?.getAttribute('aria-label')).toBe('New project');
    expect(i18n.locale).toBe('en-US');
    expect(new Intl.NumberFormat(i18n.locale).format(12345)).toBe('12,345');
  });
  it('translates static template segments but leaves substitutions and escaping intact',()=>{
    const {i18n}=mount('en');
    const userText='Yeni görev <script>Görev</script>';
    expect(i18n.template`<h2>Yeni görev</h2><p>${userText}</p>`).toBe(`<h2>New task</h2><p>${userText}</p>`);
    expect(i18n.template`${3} görev seçili`).toBe('3 tasks selected');
    expect(i18n.text('unrecognized message')).toBe('unrecognized message');
    const {window}=mount('en');
    for(const [key,value] of Object.entries((window as any).AIWSTranslationsEn)) expect(i18n.text(key),key).toBe(value);
  });
  it('persists switching in both directions and applies it on the next load',()=>{
    for(const [from,to] of [['tr','en'],['en','tr']]) {
      const {window}=mount(from);
      // The selector is rendered later by the settings page, so the listener is delegated.
      window.document.body.insertAdjacentHTML('beforeend','<select id="language-select"><option value="tr">Türkçe</option><option value="en">English</option></select>');
      const select=window.document.querySelector('#language-select') as any;
      select.value=to;select.dispatchEvent(new window.Event('change',{bubbles:true}));
      expect(window.localStorage.getItem('aiws.language')).toBe(to);
      expect(mount(window.localStorage.getItem('aiws.language')!).i18n.language).toBe(to);
    }
  });
});
