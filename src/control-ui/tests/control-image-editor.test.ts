import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

describe('image description editor', () => {
  it('uses the real editor for Markdown, upload, safe previews and cleanup', async () => {
    const { window } = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
    window.focus = () => {};
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    window.Range.prototype.getClientRects = () => [] as any;
    try {
      window.document.write('<dialog open><form><textarea name="description" id="description">Initial text</textarea><button type="submit">Save</button></form></dialog>');
      for (const path of ['../../node_modules/easymde/dist/easymde.min.js', '../../node_modules/dompurify/dist/purify.min.js', '../i18n.js', '../ui-common.js', '../ui/motion.js', '../ui/icons.js', '../ui/flow.js', '../ui/pan-zoom.js', '../images/attachments.js', '../images/file-mentions.js', '../images/markdown-editor.js', '../images/image-viewer.js', '../images/paste-path.js']) window.eval(await readFile(new URL(path, import.meta.url), 'utf8'));
      const textarea = window.document.querySelector('textarea')!;
      const api = vi.fn().mockResolvedValue({ url: '/api/attachments/' + 'a'.repeat(64) + '.png' });
      const error = vi.fn();
      const editor = (window as any).AIWSImages.editor(textarea, { api, onError: error, projectId: () => 'project-1' });
      expect(editor.value()).toBe('Initial text');
      editor.value('**Formatted**'); expect(textarea.value).toBe('**Formatted**');
      textarea.value = 'AI draft'; textarea.dispatchEvent(new window.Event('input')); expect(editor.value()).toBe('AI draft');
      const preview = window.document.createElement('div');
      editor.options.previewRender('<img src=x onerror="alert(1)"><script>alert(1)</script>\n**Safe**', preview);
      expect(preview.querySelector('script')).toBeNull();
      expect(preview.querySelector('[onerror]')).toBeNull();
      expect(preview.querySelector('strong')?.textContent).toBe('Safe');
      window.document.body.append(preview);
      window.sessionStorage.setItem('aiws.token', 'preview-token');
      const fetchImage = vi.fn(async () => new Response('image'));
      (window as any).fetch = fetchImage;
      (window.URL as any).createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/image');
      (window.URL as any).revokeObjectURL = vi.fn();
      editor.options.previewRender('![test](/api/attachments/' + 'a'.repeat(64) + '.png)', preview);
      await vi.waitFor(() => expect(preview.querySelector('img')?.src).toBe('blob:http://localhost/image'));
      expect(fetchImage).toHaveBeenCalledWith('/api/attachments/' + 'a'.repeat(64) + '.png', { headers: { Authorization: 'Bearer preview-token' } });
      const success = vi.fn(), failure = vi.fn();
      editor.options.imageUploadFunction(new window.File(['image'], 'test.png', { type: 'image/png' }), success, failure);
      expect(window.document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))).toBe(false);
      await vi.waitFor(() => expect(success).toHaveBeenCalledWith('/api/attachments/' + 'a'.repeat(64) + '.png'));
      expect(api).toHaveBeenCalledWith('/attachments', 'POST', { data: 'aW1hZ2U=', name: 'test.png', projectId: 'project-1' });
      expect(failure).not.toHaveBeenCalled();
      const paste = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { files: [new window.File(['pasted'], 'pasted.png', { type: 'image/png' })], getData: () => '', types: [] } });
      editor.codemirror.getInputField().dispatchEvent(paste);
      await vi.waitFor(() => expect(textarea.value).toContain('](/api/attachments/' + 'a'.repeat(64) + '.png)'));
      const thumbnails = window.document.querySelectorAll('.description-images img');
      expect(thumbnails).toHaveLength(1);
      await vi.waitFor(() => expect(thumbnails[0]!.getAttribute('src')).toBe('blob:http://localhost/image'));
      editor.value('No images'); expect(window.document.querySelectorAll('.description-images img')).toHaveLength(0);
      fetchImage.mockImplementation(async () => new Response('image'));
      const rendered = window.document.createElement('div');
      rendered.innerHTML = '<img data-attachment-src="/api/attachments/' + 'a'.repeat(64) + '.png" alt="x"><img data-attachment-src="https://evil.test/x.png">';
      window.document.body.append(rendered);
      await vi.waitFor(() => expect(rendered.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/image'));
      expect(rendered.querySelectorAll('img')[1]?.hasAttribute('src')).toBe(false);
      expect(fetchImage).toHaveBeenLastCalledWith('/api/attachments/' + 'a'.repeat(64) + '.png', { headers: { Authorization: 'Bearer preview-token' } });
      window.document.querySelector('form')!.dispatchEvent(new window.Event('modalreset'));
      expect(window.document.querySelector('.EasyMDEContainer')).toBeNull();
      expect(window.document.querySelector('.description-images')).toBeNull();
      expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/image');
    } finally { window.close(); }
  });
  it('switches between edit and preview from the toolbar without losing the text', async () => {
    const { window } = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
    window.focus = () => {};
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    window.Range.prototype.getClientRects = () => [] as any;
    try {
      window.document.write('<dialog open><form><textarea name="description" id="description">**Draft**</textarea></form></dialog>');
      for (const path of ['../../node_modules/easymde/dist/easymde.min.js', '../../node_modules/dompurify/dist/purify.min.js', '../i18n.js', '../ui-common.js', '../images/attachments.js', '../images/file-mentions.js', '../images/markdown-editor.js']) window.eval(await readFile(new URL(path, import.meta.url), 'utf8'));
      const editor = (window as any).AIWSImages.editor(window.document.querySelector('textarea')!, { api: vi.fn(), onError: vi.fn(), projectId: () => 'project-1' });
      const button = window.document.querySelector<HTMLButtonElement>('.editor-toolbar button.preview')!;
      const bold = window.document.querySelector<HTMLButtonElement>('.editor-toolbar button.bold')!;
      const toolbar = window.document.querySelector('.editor-toolbar')!;
      // EasyMDE's stylesheet blocks every toolbar button without no-disable while the preview is shown.
      expect(button.classList.contains('no-disable')).toBe(true);
      expect(bold.classList.contains('no-disable')).toBe(false);
      button.click();
      await vi.waitFor(() => expect(editor.isPreviewActive()).toBe(true));
      expect(window.document.querySelector('.editor-preview-active strong')?.textContent).toBe('Draft');
      expect(toolbar.classList.contains('disabled-for-preview')).toBe(true);
      button.click();
      expect(editor.isPreviewActive()).toBe(false);
      expect(toolbar.classList.contains('disabled-for-preview')).toBe(false);
      editor.codemirror.replaceRange(' more', { line: 0, ch: 9 });
      expect(editor.value()).toBe('**Draft** more');
      button.click();
      await vi.waitFor(() => expect(window.document.querySelector('.editor-preview-active')?.textContent).toContain('Draft more'));
    } finally { window.close(); }
  });
  it('uploads pasted terminal images and sends paths without submitting', async () => {
    const { window } = new JSDOM('<div id="host"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
    try {
      window.eval(await readFile(new URL('../i18n.js', import.meta.url), 'utf8'));
      window.eval(await readFile(new URL('../terminal.js', import.meta.url), 'utf8'));
      const host = window.document.querySelector('#host')!;
      const onInput = vi.fn(), onImage = vi.fn().mockResolvedValue('C:\\run\\images\\test.png'), onError = vi.fn();
      const view = (window as any).AIWSTerminal.create(host, { run: { id: 'run', status: 'running', terminalMode: 'pty' }, onInput, onImage, onResize: vi.fn(), onError });
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new window.File(['image'], 'test.png', { type: 'image/png' }) }] } });
      expect(host.dispatchEvent(event)).toBe(false);
      // The image is uploaded right away and its quoted path typed without submitting.
      await vi.waitFor(() => expect(onInput).toHaveBeenCalledWith('"C:\\run\\images\\test.png" '));
      expect(onImage).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
      expect(host.dispatchEvent(new window.Event('paste', { bubbles: true, cancelable: true }))).toBe(true);
      view.destroy();
      expect(host.querySelector('.image-paste-preview')).toBeNull();
    } finally { window.close(); }
  });
  it('searches project files after a standalone @ and inserts the chosen path', async () => {
    const { window } = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
    window.focus = () => {};
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    window.Range.prototype.getClientRects = () => [] as any;
    try {
      window.document.write('<dialog open><form><textarea name="description" id="description"></textarea></form></dialog>');
      for (const path of ['../../node_modules/easymde/dist/easymde.min.js', '../../node_modules/dompurify/dist/purify.min.js', '../i18n.js', '../ui-common.js', '../ui/motion.js', '../ui/icons.js', '../ui/flow.js', '../ui/pan-zoom.js', '../images/attachments.js', '../images/file-mentions.js', '../images/markdown-editor.js', '../images/image-viewer.js', '../images/paste-path.js']) window.eval(await readFile(new URL(path, import.meta.url), 'utf8'));
      const api = vi.fn(async (path: string) => ({ items: new URLSearchParams(path.split('?')[1]).get('q') === 'fil'
        ? [{ name: 'files.js', path: 'src/control-ui/files.js' }, { name: 'my file.md', path: 'docs/my file.md' }]
        : [{ name: 'README.md', path: 'README.md' }] }));
      const editor = (window as any).AIWSImages.editor(window.document.querySelector('textarea')!, { api, onError: vi.fn(), projectId: () => 'project-1' });
      const cm = editor.codemirror, type = (text: string) => { for (const char of text) cm.replaceRange(char, cm.getCursor(), cm.getCursor(), '+input'); };
      const key = (name: string) => cm.getInputField().dispatchEvent(new window.KeyboardEvent('keydown', { key: name, keyCode: ({ Enter: 13, ArrowDown: 40, Escape: 27 } as Record<string, number>)[name], bubbles: true, cancelable: true }));
      cm.focus(); type('mail a@b ');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(window.document.querySelector('.file-mention-popup')).toBeNull();
      type('see @');
      await vi.waitFor(() => expect(window.document.querySelectorAll('dialog .file-mention-option')).toHaveLength(1));
      expect(api).toHaveBeenLastCalledWith('/projects/project-1/files/search?q=&limit=50');
      type('fil');
      await vi.waitFor(() => expect(window.document.querySelectorAll('.file-mention-option')).toHaveLength(2));
      key('Enter');
      expect(editor.value()).toBe('mail a@b see src/control-ui/files.js ');
      expect(window.document.querySelector('.file-mention-popup')).toBeNull();
      type('@fil');
      await vi.waitFor(() => expect(window.document.querySelectorAll('.file-mention-option')).toHaveLength(2));
      key('ArrowDown'); key('Enter');
      expect(editor.value()).toBe('mail a@b see src/control-ui/files.js `docs/my file.md` ');
      type('@'); await vi.waitFor(() => expect(window.document.querySelector('.file-mention-popup')).not.toBeNull());
      key('Escape'); expect(window.document.querySelector('.file-mention-popup')).toBeNull();
      expect(editor.value()).toBe('mail a@b see src/control-ui/files.js `docs/my file.md` @');
    } finally { window.close(); }
  });
});
