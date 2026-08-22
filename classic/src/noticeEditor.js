/**
 * Rich text editor for society notice messages (Quill + sanitization)
 */
import Quill from 'quill';
import DOMPurify from 'dompurify';
import 'quill/dist/quill.snow.css';

const ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3'];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

let quill = null;

export function sanitizeNoticeHtml(html) {
    return DOMPurify.sanitize(html || '', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        ADD_ATTR: ['target', 'rel'],
    });
}

export function stripNoticeHtml(html) {
    const clean = sanitizeNoticeHtml(html);
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

export function renderNoticeBodyHtml(body) {
    if (!body?.trim()) return '';
    if (/<[a-z][\s\S]*>/i.test(body)) {
        return sanitizeNoticeHtml(body);
    }
    return body
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
}

export function initNoticeEditor() {
    const mount = document.getElementById('notice-body-editor');
    if (!mount || quill) return quill;

    quill = new Quill(mount, {
        theme: 'snow',
        placeholder: 'Write the notice residents will read…',
        modules: {
            toolbar: [
                ['bold', 'italic', 'underline'],
                [{ list: 'ordered' }, { list: 'bullet' }],
                ['link'],
                ['clean'],
            ],
        },
    });

    return quill;
}

export function resetNoticeEditor() {
    if (!quill) initNoticeEditor();
    quill?.setContents([]);
}

export function getNoticeEditorHtml() {
    if (!quill) return '';
    const raw = quill.root.innerHTML;
    if (!quill.getText().trim()) return '';
    return sanitizeNoticeHtml(raw);
}
