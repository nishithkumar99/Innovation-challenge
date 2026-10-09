/** Builds a CSV string (RFC 4180 quoting). */
export function toCsv(head: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

/**
 * Hands the CSV to the user: starts a download and also copies it to the clipboard, because some embedded
 * viewers block downloads. Resolves to what actually worked.
 */
export async function deliverCsv(filename: string, csv: string): Promise<'downloaded' | 'copied' | 'failed'> {
  let copied = false;
  try { await navigator.clipboard.writeText(csv); copied = true; } catch { /* clipboard unavailable */ }
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return copied ? 'copied' : 'downloaded';
  } catch {
    return copied ? 'copied' : 'failed';
  }
}
