import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { ResearchService } from '../src/services/research/service';
import { bibliography, parseBibtex } from '../src/domain/bibliography';
import { arxivRecords, retrieve, zoteroRecords } from '../src/services/research/providers';
const bib =
  '@article{old, title={A {Nested} Title}, author={Author}, year=2024, doi={10.1/OLD}, unknown={keep {all} fields}}';
const source =
  '\\documentclass{article}\n\\begin{document}\nClaim.\n\\bibliography{refs}\n\\end{document}\n';
const atom =
  '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>A &amp; B</title><author><name>Jane Doe</name></author><published>2024-01-01</published><summary>Evidence &lt;test&gt;</summary></entry></feed>';
let dir = '',
  store: MetadataStore | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  store?.close();
  store = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});
async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'loom-references-'));
  const root = join(dir, 'paper');
  await mkdir(root);
  await writeFile(join(root, 'main.tex'), source);
  await writeFile(join(root, 'refs.bib'), bib);
  store = new MetadataStore(join(dir, 'data'));
  const projects = new ProjectService(store);
  await projects.open(root);
  return { projects, research: new ResearchService(projects), root, id: projects.snapshot().id };
}
function citation(id: string) {
  return {
    type: 'cite' as const,
    projectId: id,
    sourcePath: 'main.tex',
    sourceText: source,
    offset: source.indexOf('Claim.') + 6,
    bibPath: 'refs.bib',
    bibText: bib,
    record: arxivRecords(atom).records[0],
    key: 'Doe2024',
    command: 'cite' as const,
  };
}
describe('bibliography and evidence', () => {
  it('preserves raw fields, comments, braces, string macros and concatenation', () => {
    const text =
      '% @invalid{comment}\n@string{prefix="Scientific"}\n@book(key,title=prefix # { {Work}},author="An {Author}",year=2025,odd={a \\} b})';
    const result = parseBibtex(text);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].fields.title).toBe('Scientific {Work}');
    expect(result.entries[0].raw).toContain('odd={a \\} b}');
  });
  it('reports missing, duplicate, incomplete and informational unused entries', () => {
    const result = bibliography([
      {
        path: 'a.bib',
        text: bib + '\n' + bib.replace('old,', 'other,') + '\n@misc{old,title={X}}',
      },
      { path: 'main.tex', text: '\\cite{missing,other}' },
    ]);
    expect(result.warnings).toContain('Missing bibliography key: missing');
    expect(result.records[0].issues).toContain('Duplicate citation key');
    expect(result.records[0].issues).toContain('Duplicate identifier');
    expect(result.records[0].issues).toContain('Unused (informational)');
    expect(result.records[2].issues.join(' ')).toContain('Incomplete');
  });
  it('rejects malformed entries rather than silently rewriting them', () => {
    expect(parseBibtex('@misc{broken, title={unclosed}').errors).toHaveLength(1);
  });
  it('reads arXiv provenance, decoded abstract and portable BibTeX', () => {
    const r = arxivRecords(atom).records[0];
    expect(r.title).toBe('A & B');
    expect(r.abstract).toBe('Evidence <test>');
    expect(r.url).toBe('https://arxiv.org/abs/2401.12345v2');
    expect(parseBibtex(r.bibtex).entries[0].fields.eprint).toBe('2401.12345v2');
    expect(arxivRecords('<feed></feed>').records).toEqual([]);
    expect(arxivRecords(atom.replace('2401.12345v2', 'error')).warnings).toHaveLength(1);
  });
  it('normalizes arXiv URLs case-insensitively when parsing results', () => {
    const mixed = atom.replace(
      'http://arxiv.org/abs/2401.12345v2',
      'HTTPS://EXPORT.ARXIV.ORG/ABS/2401.12345v2',
    );
    expect(arxivRecords(mixed).records[0].id).toBe(arxivRecords(atom).records[0].id);
  });
  it('imports Zotero exported unknown fields rather than synthesizing a different entry', () => {
    const result = zoteroRecords([
      {
        key: 'ABC',
        data: { title: 'Work', date: '2024', creators: [{ name: 'Team' }] },
        bibtex: bib,
      },
    ]);
    expect(result.records[0].bibtex).toBe(bib);
    expect(result.records[0].authors).toBe('Team');
    expect(zoteroRecords([{ data: { title: 'Incomplete' } }]).warnings).toHaveLength(1);
  });
  it('skips malformed Zotero creators while preserving valid names', () => {
    const result = zoteroRecords([
      {
        key: 'ABC',
        data: {
          title: 'Work',
          creators: [
            null,
            undefined,
            42,
            'invalid',
            {},
            { name: 7 },
            { name: 'Team' },
            { firstName: 'Jane', lastName: 'Doe' },
          ],
        },
        bibtex: bib,
      },
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].authors).toBe('Team and Jane Doe');
    expect(result.records[0].bibtex).toBe(bib);
  });
  it('uses bounded GET requests and reports rate limits, partial feeds and failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(atom));
    await retrieve('arxiv', 'test claim', new AbortController().signal, fetcher);
    expect(fetcher.mock.calls[0][0].hostname).toBe('export.arxiv.org');
    fetcher.mockResolvedValue(new Response('', { status: 429 }));
    await expect(retrieve('arxiv', 'x', new AbortController().signal, fetcher)).rejects.toThrow(
      'rate limited',
    );
    fetcher.mockRejectedValue(new Error('offline'));
    await expect(retrieve('zotero', 'x', new AbortController().signal, fetcher)).rejects.toThrow(
      'Open Zotero',
    );
  });
});
describe('grouped citation persistence', () => {
  it('appends only one entry, preserves existing bytes and reuses repeated imports', async () => {
    const { research, root, id } = await setup();
    const first = await research.command(citation(id));
    expect(first.message).toContain('Imported');
    const bibAfter = await readFile(join(root, 'refs.bib'), 'utf8'),
      texAfter = await readFile(join(root, 'main.tex'), 'utf8');
    expect(bibAfter.startsWith(bib)).toBe(true);
    expect(texAfter).toContain('Claim.\\cite{Doe2024}');
    const second = await research.command({
      ...citation(id),
      sourceText: texAfter,
      bibText: bibAfter,
      offset: texAfter.indexOf('Claim.'),
    });
    expect(second.message).toContain('existing');
    expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bibAfter);
  });
  it('rejects stale source, collision and undeclared bibliography without writes', async () => {
    const { research, root, id } = await setup();
    await expect(research.command({ ...citation(id), sourceText: 'stale' })).rejects.toThrow(
      'source changed',
    );
    await expect(research.command({ ...citation(id), key: 'old' })).rejects.toThrow(
      'another record',
    );
    await expect(
      research.command({ ...citation(id), bibPath: 'other.bib', bibText: null }),
    ).rejects.toThrow('does not declare');
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(source);
    expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bib);
  });
  it('retains a durable group across an interrupted second write and finishes idempotently', async () => {
    const { projects, research, root, id } = await setup();
    const original = projects.agentRestore.bind(projects);
    let writes = 0;
    vi.spyOn(projects, 'agentRestore').mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error('Interrupted write');
      return original(...args);
    });
    await expect(research.command(citation(id))).rejects.toThrow('Interrupted');
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(source);
    expect(await readFile(join(root, 'refs.bib'), 'utf8')).toContain('Doe2024');
    vi.restoreAllMocks();
    const fresh = new ResearchService(projects);
    expect(
      (await fresh.command({ type: 'recovery', projectId: id, action: 'inspect' })).recovery,
    ).toBe(true);
    await fresh.command({ type: 'recovery', projectId: id, action: 'finish' });
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toContain('\\cite{Doe2024}');
    expect(
      (await fresh.command({ type: 'recovery', projectId: id, action: 'inspect' })).recovery,
    ).toBe(false);
  });
  it('undoes partial imports and refuses recovery over newer human text', async () => {
    const { projects, research, root, id } = await setup();
    const original = projects.agentRestore.bind(projects);
    let writes = 0;
    vi.spyOn(projects, 'agentRestore').mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error('Interrupted');
      return original(...args);
    });
    await expect(research.command(citation(id))).rejects.toThrow();
    vi.restoreAllMocks();
    await writeFile(join(root, 'main.tex'), source + 'new writing');
    await expect(
      research.command({ type: 'recovery', projectId: id, action: 'undo' }),
    ).rejects.toThrow('newer edits');
    expect(await readFile(join(root, 'refs.bib'), 'utf8')).toContain('Doe2024');
    await writeFile(join(root, 'main.tex'), source);
    await research.command({ type: 'recovery', projectId: id, action: 'undo' });
    expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bib);
  });
  it('blocks citation writes while an agent is active', async () => {
    const { projects, id } = await setup();
    await expect(new ResearchService(projects, () => true).command(citation(id))).rejects.toThrow(
      'Stop the agent',
    );
  });
});

it('does not equate distinct Unicode titles or conflicting identifiers', async () => {
  const { sameRecord } = await import('../src/domain/bibliography');
  const a = { ...arxivRecords(atom).records[0], title: '研究甲', doi: '' },
    b = { ...a, title: '研究乙', url: '', bibtex: '@misc{b,title={研究乙}}' };
  expect(sameRecord(a, b)).toBe(false);
  expect(
    sameRecord(
      { ...a, doi: '10.0000/a' },
      { ...a, doi: '10.0000/b', url: '', bibtex: '@misc{b,title={研究甲}}' },
    ),
  ).toBe(false);
});
it('follows the selected main document graph and normalizes literal resource paths', async () => {
  const { manuscriptResources } = await import('../src/domain/bibliography');
  const files = [
    { id: 'root', path: 'main.tex', text: '\\input{sections/intro}\\bibliography{./refs}' },
    { id: 'chapter', path: 'sections/intro.tex', text: '\\addbibresource{other.bib}' },
    { id: 'unrelated', path: 'unrelated.tex', text: '\\bibliography{unused}' },
  ];
  expect(manuscriptResources(files, 'root').resources).toEqual(['refs.bib', 'other.bib']);
  const { research, projects, id } = await setup();
  await writeFile(join(dir, 'paper', 'unused.tex'), '\\bibliography{disconnected}');
  await projects.refresh();
  await expect(
    research.command({ ...citation(id), bibPath: 'disconnected.bib', bibText: null }),
  ).rejects.toThrow('does not declare');
});
it('reports oversized records as partial results and keeps ordinary files unchanged', async () => {
  const { research, root, id } = await setup();
  const oversized = '@misc{large,title={' + 'x'.repeat(210000) + '}}';
  await writeFile(join(root, 'big.bib'), oversized);
  const result = await research.command({
    type: 'search',
    projectId: id,
    provider: 'local',
    query: '',
    requestId: 'large',
  });
  expect(result.records).toHaveLength(1);
  expect(result.warnings.join(' ')).toContain('1 records omitted');
  expect(await readFile(join(root, 'big.bib'), 'utf8')).toBe(oversized);
});
it('allows inspection and an explicit keep-current resolution after overlapping newer work', async () => {
  const { projects, research, root, id } = await setup();
  const original = projects.agentRestore.bind(projects);
  let writes = 0;
  vi.spyOn(projects, 'agentRestore').mockImplementation(async (...args) => {
    if (++writes === 2) throw new Error('Interrupted');
    return original(...args);
  });
  await expect(research.command(citation(id))).rejects.toThrow();
  vi.restoreAllMocks();
  await writeFile(join(root, 'main.tex'), source + 'newer');
  const inspected = await research.command({ type: 'recovery', projectId: id, action: 'inspect' });
  expect(inspected.recoveryFiles?.[1].before).toBe(source);
  expect(inspected.recoveryFiles?.[1].current).toBe(source + 'newer');
  await research.command({ type: 'recovery', projectId: id, action: 'keep' });
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(source + 'newer');
  expect(
    (await research.command({ type: 'recovery', projectId: id, action: 'inspect' })).recovery,
  ).toBe(false);
});
it('cancels before a queued project check can send a remote query', async () => {
  const { projects, id } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const blocked = projects.run(() => gate);
  const fetcher = vi.fn();
  const research = new ResearchService(projects, () => false, fetcher);
  const pending = research.command({
    type: 'search',
    projectId: id,
    requestId: 'queued',
    provider: 'arxiv',
    query: 'private claim',
  });
  const rejected = expect(pending).rejects.toThrow('canceled');
  await research.command({ type: 'cancel', requestId: 'queued' });
  release();
  await blocked;
  await rejected;
  expect(fetcher).not.toHaveBeenCalled();
});
it('indexes and searches 5,000 synthetic bibliography records within the initial search budget', async () => {
  const { research, root, id } = await setup();
  const large = Array.from(
    { length: 5000 },
    (_, i) => `@misc{key${i},title={Paper ${i}},author={Writer},year={2024},doi={10.0000/${i}}}`,
  ).join('\n');
  await writeFile(join(root, 'refs.bib'), large);
  const start = performance.now();
  const result = await research.command({
    type: 'search',
    projectId: id,
    requestId: 'many',
    provider: 'local',
    query: 'Paper 4999',
  });
  expect(result.records).toHaveLength(1);
  expect(performance.now() - start).toBeLessThan(1000);
});
it('keeps non-arXiv eprint identifiers separate from actual arXiv records', async () => {
  const { identifiers, sameRecord } = await import('../src/domain/bibliography');
  const arxiv = arxivRecords(atom).records[0];
  const other = {
    ...arxiv,
    id: 'other',
    url: '',
    title: 'Distinct paper',
    bibtex: '@misc{other,title={Distinct paper},eprint={2401.12345v2},archivePrefix={SSRN}}',
  };
  expect(identifiers(other)).toEqual([]);
  expect(sameRecord(arxiv, other)).toBe(false);
});
it('allows explicit distinct-source import for a title-only collision', async () => {
  const { research, root, id } = await setup();
  const noDoi = bib.replace(', doi={10.1/OLD}', '');
  await writeFile(join(root, 'refs.bib'), noDoi);
  const incoming = { ...arxivRecords(atom).records[0], title: 'A {Nested} Title' };
  incoming.bibtex = incoming.bibtex.replace('title = {A \\& B}', 'title = {A {Nested} Title}');
  await expect(
    research.command({ ...citation(id), bibText: noDoi, record: incoming }),
  ).rejects.toThrow('Confirm');
  await research.command({
    ...citation(id),
    bibText: noDoi,
    record: incoming,
    differentTitle: true,
  });
  const result = await readFile(join(root, 'refs.bib'), 'utf8');
  expect(result.startsWith(noDoi)).toBe(true);
  expect(result).toContain('@misc{Doe2024,');
  const currentSource = await readFile(join(root, 'main.tex'), 'utf8');
  const repeated = await research.command({
    ...citation(id),
    record: incoming,
    sourceText: currentSource,
    bibText: result,
  });
  expect(repeated.message).toContain('existing');
  expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(result);
});
