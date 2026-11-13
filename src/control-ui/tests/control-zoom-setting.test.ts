import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app/zoom-setting.js', import.meta.url), 'utf8');
function mount(zoom?: unknown) {
  const window = new Window({ url: 'http://localhost' }) as any;
  window.aiwsDesktop = zoom ? { zoom } : undefined;
  window.AIWSI18n = { text: (value: string) => value };
  window.esc = (value: string) => value;
  window.$ = (selector: string) => window.document.querySelector(selector);
  window.eval(`${source};window.zoomSettingMarkup=zoomSettingMarkup;window.syncZoomSetting=syncZoomSetting;`);
  window.document.body.innerHTML = window.zoomSettingMarkup();
  return window;
}

describe('desktop zoom setting', () => {
  it('is absent in a browser', () => { expect(mount().document.querySelector('.zoom-setting')).toBeNull(); });
  it('shows the level, changes it from the buttons, follows other windows and disables a step at its limit', async () => {
    let push: (state: unknown) => void = () => {};
    const level = (percent: number) => ({ percent, min: 50, max: 200, default: 100 });
    const zoom = { get: vi.fn().mockResolvedValue(level(100)), change: vi.fn().mockResolvedValue(level(110)), onChange: (callback: (state: unknown) => void) => { push = callback; } };
    const window = mount(zoom), find = (selector: string) => window.document.querySelector(selector);
    await vi.waitFor(() => expect(find('#zoom-setting-level').textContent).toBe('100%'));
    expect(find('[data-zoom-change=reset]').disabled).toBe(true);
    find('[data-zoom-change=in]').click();
    expect(zoom.change).toHaveBeenCalledWith('in');
    await vi.waitFor(() => expect(find('#zoom-setting-level').textContent).toBe('110%'));
    expect(find('[data-zoom-change=reset]').disabled).toBe(false);
    push(level(200));
    expect(find('#zoom-setting-level').textContent).toBe('200%');
    expect(find('[data-zoom-change=in]').disabled).toBe(true);
  });
});
