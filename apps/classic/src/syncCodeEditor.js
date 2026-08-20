/** Lightweight code-editor chrome for sync formula snippets (textarea + tab + auto-height). */

function escapeTextareaContent(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;');
}

export function wireCodeEditor(wrapper) {
    const ta = wrapper?.querySelector('textarea');
    if (!ta || ta.dataset.codeWired) return;
    ta.dataset.codeWired = '1';

    const resize = () => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.max(80, ta.scrollHeight)}px`;
    };
    resize();
    ta.addEventListener('input', resize);

    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const val = ta.value;
        ta.value = `${val.slice(0, start)}  ${val.slice(end)}`;
        ta.selectionStart = ta.selectionEnd = start + 2;
        resize();
    });
}

export function wireCodeEditors(root) {
    root?.querySelectorAll('[data-code-editor]').forEach(wireCodeEditor);
}

export function renderSnippetRowHtml(name = '', body = '') {
    return `
      <div class="sync-snippet-row" data-snippet-row>
        <label class="sync-snippet-row__name-wrap">
          <span class="sync-snippet-row__label">Name</span>
          <input type="text" class="sync-snippet-row__name" data-snippet-name value="${escapeAttr(name)}" placeholder="bank_line" spellcheck="false" />
        </label>
        <div class="sync-snippet-row__editor-wrap">
          <span class="sync-snippet-row__label">Expression</span>
          <div class="sync-code-editor" data-code-editor>
            <textarea class="sync-code-editor__input" data-snippet-body rows="4" spellcheck="false" placeholder="CONCAT({field:bank_payment_type}, &quot; &quot;, {field:bank_reference})">${escapeTextareaContent(body)}</textarea>
          </div>
        </div>
        <button type="button" class="btn btn-outline btn--small sync-snippet-row__del" data-snippet-del title="Remove">×</button>
      </div>`;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export const FORMULA_REFERENCES = [
    {
        token: '{value}',
        importDesc: 'Raw Excel cell for the field whose formula is running',
        exportDesc: 'DB value for the field whose formula is running',
    },
    {
        token: '{field:amount}',
        importDesc: 'Another field on the same Excel row (already parsed earlier in the row)',
        exportDesc: 'Another DB column on the same transaction (e.g. type, wallet, bank_reference)',
    },
    {
        token: '{col:3}',
        importDesc: 'Raw Excel column by index (0 = column A). Works even if that column is not mapped',
        exportDesc: 'Not available — export only reads from the database',
    },
];

/** Export example: combine two DB fields into one Excel cell */
export const CUSTOM_FN_SAMPLE = `/**
 * bank_line — export DB fields into one Excel cell
 *
 * Scope: same transaction / same Excel row.
 *   {value}                    → this field's value (DB on export, Excel on import)
 *   {field:bank_payment_type}  → Bank payment type column
 *   {field:bank_reference}     → Bank reference column
 *
 * Use in any formula: @bank_line
 */
function bank_line() {
  return CONCAT(
    {field:bank_payment_type},
    " ",
    {field:bank_reference}
  );
}`;

export const CUSTOM_FN_SAMPLE_EXPRESSION = `CONCAT(
  {field:bank_payment_type},
  " ",
  {field:bank_reference}
)`;

/** Import example: read another Excel column on the same row */
export const CUSTOM_FN_IMPORT_SAMPLE = `/**
 * Import only — read unmapped Excel column "Bank Details" (column index 10)
 *
 *   {value}    → this cell (if this field is mapped to a column)
 *   {col:10}   → raw Excel column 11, same row (0-based index)
 *   {field:cat} → Category already parsed from this row
 */
function bank_from_excel_col() {
  return TRIM({col:10});
}`;

export const CUSTOM_FN_IMPORT_SAMPLE_EXPRESSION = `TRIM({col:10})`;
