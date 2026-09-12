/**
 * Taxonomy assignment coverage.
 *
 * Written after a real dataset produced a composition plot made almost
 * entirely of "Unclassified Bacteria", "Unclassified Proteobacteria" and so
 * on. Nothing was mis-parsed: only 14% of features in that freshwater dataset
 * carry a genus assignment, and the tool defaulted to genus without saying so.
 * Measuring coverage lets the interface start at a rank that is mostly
 * populated and warn when it is not.
 */

import { describe, expect, it } from 'vitest';

import { describeCoverage, parseLineage, taxonomyCoverage } from '../src/index.js';

const lineage = (s: string) => parseLineage(s);

describe('taxonomyCoverage', () => {
  it('counts assignments at each rank', () => {
    const coverage = taxonomyCoverage([
      lineage('d__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia'),
      lineage('d__Bacteria;p__Firmicutes;c__Bacilli'),
      lineage('d__Bacteria;p__Bacteroidota'),
      lineage('d__Bacteria'),
    ]);

    const at = (rank: string) =>
      coverage.byRank.find((r) => r.rank === rank)!;

    expect(at('domain').assigned).toBe(4);
    expect(at('phylum').assigned).toBe(3);
    expect(at('class').assigned).toBe(2);
    expect(at('genus').assigned).toBe(1);
    expect(at('domain').fraction).toBe(1);
    expect(at('genus').fraction).toBe(0.25);
  });

  it('picks the deepest rank that is mostly assigned', () => {
    const coverage = taxonomyCoverage([
      lineage('d__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia'),
      lineage('d__Bacteria;p__Firmicutes;c__Bacilli'),
      lineage('d__Bacteria;p__Bacteroidota;c__Bacteroidia'),
      lineage('d__Bacteria;p__Bacteroidota'),
    ]);
    // domain 100%, phylum 100%, class 75%, genus 25% -> class.
    expect(coverage.bestRank).toBe('class');
  });

  it('falls back to domain when nothing meets the threshold', () => {
    const coverage = taxonomyCoverage([lineage(''), lineage(''), lineage('')]);
    expect(coverage.bestRank).toBe('domain');
  });

  it('honours a custom threshold', () => {
    const lineages = [
      lineage('d__Bacteria;p__Firmicutes;g__Blautia'),
      lineage('d__Bacteria;p__Firmicutes'),
      lineage('d__Bacteria;p__Firmicutes'),
      lineage('d__Bacteria;p__Firmicutes'),
    ];
    // Genus is 25%: excluded at the default 50%, included at 20%.
    expect(taxonomyCoverage(lineages).bestRank).toBe('phylum');
    expect(taxonomyCoverage(lineages, 0.2).bestRank).toBe('genus');
  });

  it('counts organelle features at any rank', () => {
    const coverage = taxonomyCoverage([
      lineage('d__Bacteria;p__Cyanobacteria;c__Chloroplast'),
      lineage('d__Bacteria;p__Proteobacteria;f__mitochondria'),
      lineage('d__Bacteria;p__Firmicutes;g__Blautia'),
    ]);
    // Chloroplast and mitochondria are eukaryotic organelles, not bacteria.
    expect(coverage.organelleFeatures).toBe(2);
  });

  it('handles an empty input without dividing by zero', () => {
    const coverage = taxonomyCoverage([]);
    expect(coverage.byRank.every((r) => r.fraction === 0)).toBe(true);
    expect(coverage.bestRank).toBe('domain');
  });
});

describe('describeCoverage', () => {
  it('warns when genus is sparsely assigned, naming a better rank', () => {
    const lineages = [
      lineage('d__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia'),
      ...Array.from({ length: 9 }, () =>
        lineage('d__Bacteria;p__Firmicutes;c__Clostridia'),
      ),
    ];
    const messages = describeCoverage(taxonomyCoverage(lineages));
    expect(messages.join(' ')).toMatch(/10% of features have a genus/);
    expect(messages.join(' ')).toMatch(/class is the deepest rank/);
  });

  it('says nothing about genus when it is well assigned', () => {
    const lineages = Array.from({ length: 10 }, () =>
      lineage('d__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia'),
    );
    expect(describeCoverage(taxonomyCoverage(lineages))).toEqual([]);
  });

  it('reports organelle contamination and explains why it matters', () => {
    const lineages = [
      lineage('d__Bacteria;p__Cyanobacteria;c__Chloroplast;g__x'),
      ...Array.from({ length: 9 }, () =>
        lineage('d__Bacteria;p__Firmicutes;c__Clostridia;g__Blautia'),
      ),
    ];
    const messages = describeCoverage(taxonomyCoverage(lineages)).join(' ');
    expect(messages).toMatch(/chloroplast/i);
    expect(messages).toMatch(/not bacteria/i);
  });
});
