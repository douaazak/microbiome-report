# microbiome-core

Compositional statistics for microbiome feature tables. Pure TypeScript, no DOM, no dependencies.

This is the statistical core of a client-side microbiome analysis tool. It is deliberately separate from any UI so it can be tested, versioned and published on its own.

## What it does

- **CLR transform** with explicit, configurable zero replacement
- **Wilcoxon rank-sum** and **Kruskal–Wallis**, both with tie correction
- **Benjamini–Hochberg** FDR control, matching R's `p.adjust(method = "BH")`
- **Differential abundance**: CLR → non-parametric test per feature → BH across features

## What it deliberately does not do

No covariates, no random effects, no repeated measures. Those need MaAsLin 3, and the plan is to run the real package under WebR rather than reimplement it — a subtly wrong differential abundance method is worse than an honest simple one. This module should never grow into a half-correct imitation of MaAsLin.

## Usage

```ts
import { differentialAbundance } from 'microbiome-core';

const table = [        // features (rows) x samples (columns)
  [10, 12, 11, 900, 880, 920],
  [500, 490, 510, 495, 505, 500],
];
const featureIds = ['Bacteroides', 'Prevotella'];
const groups = ['ctrl', 'ctrl', 'ctrl', 'trt', 'trt', 'trt'];

const { results, warnings, testedCount } = differentialAbundance(
  table,
  featureIds,
  groups,
  { minPrevalence: 0.1, minGroupSize: 3 },
);
```

Each result carries `p`, `q`, `effectSize`, per-group CLR means, and — when a feature was not tested — an `excludedReason` explaining why. Features that fail filters are reported rather than dropped, and they are kept out of the FDR denominator so they cannot deflate everyone else's q-values.

## Three things worth knowing before trusting the output

**CLR is not a formality.** Microbiome counts are compositional: only ratios carry information, because sequencing depth is an artefact rather than biology. The consequence people find surprising is that *one feature rising forces the others down in CLR space*. On a small table this manufactures apparent depletion across the background. The module warns below 10 features and refuses to pretend below 2, where CLR is mathematically degenerate — every value becomes `log(x) - log(x) = 0`.

**Zero replacement is a modelling choice, not a detail.** The geometric mean is undefined when any part is zero, and microbiome data is mostly zeros. Both strategies are exposed (`pseudocount`, `multiplicative`) rather than buried, because they give different answers.

**P-values have a precision floor.** The normal CDF here uses an approximation with ~1.5e-7 absolute error. That is ample for deciding significance at conventional thresholds and useless for distinguishing 1e-9 from 1e-12. `P_VALUE_PRECISION_FLOOR` is exported; display anything at or below it as `< 1e-6`.

## Development

```bash
npm install
npm test        # 38 tests
npm run typecheck
npm run build
```

## Testing approach

Every reference value is either analytic or comes from R, with the exact call in a comment so it can be re-derived instead of taken on trust:

```
// R: wilcox.test(1:5, 6:10, exact = FALSE, correct = TRUE)
//    W = 0, p-value = 0.01216
```

Statistical fixtures use a seeded LCG rather than `Math.random`, because a flaky statistical test is worse than no test.

The next step is a fuller validation suite that runs `vegan` in CI and asserts agreement on a fixture dataset.

## Licence

MIT
