import { useState } from 'react';
import { RANKS, type Rank } from 'microbiome-core';

import { AlphaPanel } from './components/AlphaPanel';
import { BetaPanel } from './components/BetaPanel';
import { CompositionPanel } from './components/CompositionPanel';
import { DifferentialPanel } from './components/DifferentialPanel';
import { Select } from './components/Select';
import { loadDataset, type Dataset, type InputKind } from './lib/load';

const TABS = ['Composition', 'Alpha diversity', 'Beta diversity', 'Differential'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [kind, setKind] = useState<InputKind>('asv');
  const [rank, setRank] = useState<Rank>('genus');
  const [tableText, setTableText] = useState<string>();
  const [taxonomyText, setTaxonomyText] = useState<string>();
  const [metadataText, setMetadataText] = useState<string>();

  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Composition');

  function run(
    overrides: Partial<{
      kind: InputKind;
      tableText: string;
      taxonomyText?: string;
      metadataText: string;
      rank: Rank;
    }> = {},
  ) {
    const table = overrides.tableText ?? tableText;
    const meta = overrides.metadataText ?? metadataText;
    const taxonomy =
      'taxonomyText' in overrides ? overrides.taxonomyText : taxonomyText;
    const activeKind = overrides.kind ?? kind;
    const activeRank = overrides.rank ?? rank;

    if (!table || !meta) {
      setError('A feature table and a metadata file are both required.');
      return;
    }

    try {
      setDataset(
        loadDataset(
          activeKind === 'metaphlan'
            ? {
                kind: 'metaphlan',
                tableText: table,
                metadataText: meta,
                rank: activeRank,
              }
            : {
                kind: 'asv',
                tableText: table,
                metadataText: meta,
                taxonomyText: taxonomy,
              },
        ),
      );
      setError(null);
    } catch (caught) {
      setDataset(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function loadDemo() {
    try {
      const [table, taxonomy, meta] = await Promise.all([
        fetch('./demo/feature-table.tsv').then((r) => r.text()),
        fetch('./demo/taxonomy.tsv').then((r) => r.text()),
        fetch('./demo/metadata.tsv').then((r) => r.text()),
      ]);
      setKind('asv');
      setTableText(table);
      setTaxonomyText(taxonomy);
      setMetadataText(meta);
      run({
        kind: 'asv',
        tableText: table,
        taxonomyText: taxonomy,
        metadataText: meta,
      });
    } catch {
      setError('Could not load the demo dataset.');
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Microbiome Report</h1>
        <p className="tagline">
          Everything runs in this browser tab. Your data is never uploaded.
        </p>
      </header>

      <section className="loader">
        <div className="controls">
          <Select
            label="Input type"
            value={kind}
            onChange={(v) => setKind(v as InputKind)}
            options={[
              { value: 'asv', label: 'ASV / OTU table' },
              { value: 'metaphlan', label: 'MetaPhlAn' },
            ]}
          />
          {kind === 'metaphlan' && (
            <Select
              label="Rank"
              value={rank}
              onChange={(v) => setRank(v as Rank)}
              options={RANKS.map((r) => ({ value: r, label: r }))}
            />
          )}
        </div>

        <div className="files">
          <FileInput
            label="Feature table"
            required
            loaded={Boolean(tableText)}
            onLoad={setTableText}
          />
          {kind === 'asv' && (
            <FileInput
              label="Taxonomy (optional)"
              loaded={Boolean(taxonomyText)}
              onLoad={setTaxonomyText}
            />
          )}
          <FileInput
            label="Metadata"
            required
            loaded={Boolean(metadataText)}
            onLoad={setMetadataText}
          />
        </div>

        <div className="actions">
          <button type="button" className="primary" onClick={() => run()}>
            Analyse
          </button>
          <button type="button" onClick={loadDemo}>
            Load demo data
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}
      </section>

      {dataset && (
        <>
          <section className="diagnostics">
            <h2>
              {dataset.table.featureIds.length} features ×{' '}
              {dataset.table.sampleIds.length} samples
              {dataset.isCounts ? ' (counts)' : ' (relative abundance)'}
            </h2>
            {dataset.diagnostics.length === 0 ? (
              <p className="ok">Parsed with no issues to report.</p>
            ) : (
              <ul>
                {dataset.diagnostics.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </section>

          <nav className="tabs">
            {TABS.map((name) => (
              <button
                type="button"
                key={name}
                className={name === tab ? 'active' : undefined}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </nav>

          <main>
            {tab === 'Composition' && <CompositionPanel dataset={dataset} />}
            {tab === 'Alpha diversity' && <AlphaPanel dataset={dataset} />}
            {tab === 'Beta diversity' && <BetaPanel dataset={dataset} />}
            {tab === 'Differential' && <DifferentialPanel dataset={dataset} />}
          </main>
        </>
      )}
    </div>
  );
}

interface FileInputProps {
  label: string;
  required?: boolean;
  loaded: boolean;
  onLoad: (text: string) => void;
}

function FileInput({ label, required, loaded, onLoad }: FileInputProps) {
  const [name, setName] = useState<string>();

  return (
    <label className="file-input">
      <span>
        {label}
        {required && <em> *</em>}
      </span>
      <input
        type="file"
        accept=".tsv,.csv,.txt"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setName(file.name);
          onLoad(await file.text());
        }}
      />
      {loaded && name && <small className="ok">{name}</small>}
    </label>
  );
}
