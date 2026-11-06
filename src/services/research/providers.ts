import type { Reference } from '../../contracts/research';
import { makeBibtex, parseBibtex } from '../../domain/bibliography';
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (raw, n, name) => {
      if (n) {
        const code = n[0] === 'x' ? parseInt(n.slice(1), 16) : Number(n);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
      }
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name] ??
        raw
      );
    });
const tag = (xml: string, name: string) =>
  decode(
    new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`).exec(
      xml,
    )?.[1] ?? '',
  )
    .replace(/\s+/g, ' ')
    .trim();
export function arxivRecords(xml: string) {
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !/<(?:\w+:)?feed[\s>]/.test(xml) ||
    !/<\/(?:\w+:)?feed>/.test(xml)
  )
    throw new Error('arXiv returned an invalid feed. Retry later.');
  const records: Reference[] = [],
    warnings: string[] = [];
  for (const match of xml.matchAll(/<(?:\w+:)?entry(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?entry>/g)) {
    const entry = match[1],
      id = tag(entry, 'id').replace(/^https?:\/\/(?:export\.)?arxiv\.org\/abs\//i, '');
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(id)) {
      warnings.push('An arXiv result could not be read; no metadata was invented.');
      continue;
    }
    const title = tag(entry, 'title'),
      authors = [...entry.matchAll(/<(?:\w+:)?author>([\s\S]*?)<\/(?:\w+:)?author>/g)]
        .map((m) => tag(m[1], 'name'))
        .filter(Boolean)
        .join(' and ');
    if (!title) {
      warnings.push('A result with no title was omitted.');
      continue;
    }
    const record: Reference = {
      id: 'arxiv:' + id,
      provider: 'arxiv',
      path: '',
      key: 'arxiv' + id.replace(/[^a-z0-9]/gi, ''),
      title,
      authors,
      year: tag(entry, 'published').slice(0, 4),
      doi: tag(entry, 'doi'),
      url: 'https://arxiv.org/abs/' + id,
      abstract: tag(entry, 'summary'),
      bibtex: '',
      issues: [],
    };
    record.bibtex = makeBibtex(record, record.key, { eprint: id, archivePrefix: 'arXiv' });
    records.push(record);
  }
  return { records, warnings };
}
export function zoteroRecords(input: unknown) {
  if (!Array.isArray(input)) throw new Error('Zotero returned an invalid library response.');
  const records: Reference[] = [],
    warnings: string[] = [];
  for (const item of input.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const data = item.data;
    if (!data || ['note', 'attachment', 'annotation'].includes(data.itemType)) continue;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const bibtex = str(item.bibtex),
      entry = parseBibtex(bibtex).entries[0];
    if (!entry || !str(data.title)) {
      warnings.push('A Zotero item without a supported BibTeX export was omitted.');
      continue;
    }
    const record: Reference = {
      id: 'zotero:' + str(item.key),
      provider: 'zotero',
      path: '',
      key: entry.key,
      title: str(data.title),
      authors: Array.isArray(data.creators)
        ? data.creators
            .map((c: unknown) => {
              if (!c || typeof c !== 'object') return '';
              const creator = c as Record<string, unknown>;
              return (
                str(creator.name) ||
                [str(creator.firstName), str(creator.lastName)].filter(Boolean).join(' ')
              );
            })
            .filter(Boolean)
            .join(' and ')
        : '',
      year: str(data.date),
      doi: str(data.DOI),
      url: str(data.url),
      abstract: str(data.abstractNote),
      bibtex,
      issues: [],
    };
    if (!record.url && record.doi) record.url = 'https://doi.org/' + record.doi;
    records.push(record);
  }
  return { records, warnings };
}
export async function retrieve(
  provider: 'arxiv' | 'zotero',
  query: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const url =
    provider === 'arxiv'
      ? new URL('https://export.arxiv.org/api/query')
      : new URL('http://localhost:23119/api/users/0/items/top');
  if (provider === 'arxiv') {
    const identifier = query
      .trim()
      .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
      .replace(/\.pdf$/, '');
    if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(identifier))
      url.searchParams.set('id_list', identifier);
    else
      url.searchParams.set(
        'search_query',
        query
          .split(/\s+/)
          .filter(Boolean)
          .map((word) => 'all:' + JSON.stringify(word))
          .join(' AND '),
      );
    url.searchParams.set('max_results', '30');
  } else {
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '50');
    url.searchParams.set('format', 'json');
    url.searchParams.set('include', 'data,bibtex');
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      signal,
      redirect: 'error',
      headers:
        provider === 'zotero'
          ? { 'Zotero-API-Version': '3' }
          : { 'User-Agent': 'Loom/0.1 literature search' },
    });
  } catch {
    if (signal.aborted) throw new Error('Search canceled or timed out.');
    throw new Error(
      provider === 'zotero'
        ? 'Zotero is unavailable. Open Zotero and enable Settings → Advanced → Allow other applications on this computer to communicate with Zotero.'
        : 'arXiv is unavailable. Check the connection and retry.',
    );
  }
  if (response.status === 429 || response.status === 503)
    throw new Error(
      `${provider === 'arxiv' ? 'arXiv' : 'Zotero'} is busy or rate limited. Wait before retrying${response.headers.get('Retry-After') ? ' (Retry-After: ' + response.headers.get('Retry-After')?.slice(0, 40) + ')' : ''}.`,
    );
  if (!response.ok)
    throw new Error(
      provider === 'zotero' && response.status === 403
        ? 'Enable local API access in Zotero Settings → Advanced, then retry.'
        : `${provider} returned HTTP ${response.status}. Retry later.`,
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The provider returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024)
        throw new Error('The provider response is too large. Narrow the search.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const body = new TextDecoder().decode(bytes);
  return provider === 'arxiv' ? arxivRecords(body) : zoteroRecords(JSON.parse(body));
}
