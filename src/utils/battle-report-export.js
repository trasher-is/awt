// Local archive exports only: no game requests and no reshaping of recorded observations.
const SORT_KEYS = new Set(['occurred_at', 'cv', 'pop', 'att_cv', 'def_cv']);

function parseBattleReportFilters(query = {}) {
    return {
        q: typeof query.q === 'string' ? query.q.slice(0, 200) : '',
        sort: SORT_KEYS.has(query.sort) ? query.sort : 'occurred_at',
        dir: query.dir === 'asc' ? 'asc' : 'desc',
    };
}

function csvCell(value) {
    if (value == null) return '';
    if (typeof value === 'number') return String(value);
    let text = String(value);
    // Quoting alone does not prevent spreadsheet formulas. Neutralize string cells,
    // including formulas hidden behind whitespace/control characters; numbers stay numeric.
    if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function serializeBattleReportExport({ columns, rows, format, scope, filters, exportedAt = new Date().toISOString() }) {
    if (format === 'csv') {
        // BOM makes non-ASCII player/system names readable in spreadsheet applications.
        return '\uFEFF' + [columns.map(csvCell).join(','),
            ...rows.map(row => columns.map(column => csvCell(row[column])).join(',')),
        ].join('\r\n') + '\r\n';
    }
    return JSON.stringify({
        schema_version: 1,
        exported_at: exportedAt,
        scope,
        filters: scope === 'filtered' ? filters : null,
        total: rows.length,
        records: rows,
    }, null, 2) + '\n';
}

module.exports = { parseBattleReportFilters, serializeBattleReportExport };
