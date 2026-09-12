export {
  clrTransformSample,
  clrTransformTable,
  DEFAULT_ZERO_REPLACEMENT,
  type ZeroReplacement,
} from './clr.js';

export {
  chiSquareUpperTail,
  erf,
  logGamma,
  lowerGamma,
  normalCdf,
  P_VALUE_PRECISION_FLOOR,
} from './distributions.js';

export { rankWithTies, tieCorrectionSum, type RankResult } from './ranks.js';

export {
  benjaminiHochberg,
  kruskalWallis,
  wilcoxonRankSum,
  type KruskalResult,
  type WilcoxonResult,
} from './tests.js';

export {
  differentialAbundance,
  type DifferentialOptions,
  type DifferentialResult,
  type FeatureResult,
} from './differential.js';

export {
  DEFAULT_NULL_TOKENS,
  describeLineageDiagnostics,
  hasGap,
  labelAtRank,
  parseLineage,
  parseLineages,
  RANKS,
  type LineageDiagnostics,
  type LineageOptions,
  type LineageParseResult,
  type ParsedLineage,
  type Rank,
} from './taxonomy.js';

export {
  joinTableAndMetadata,
  parseFeatureTable,
  parseMetadata,
  transpose,
  type FeatureTable,
  type JoinResult,
  type Metadata,
  type MetadataColumn,
  type MetadataColumnType,
  type MetadataParseOptions,
  type TableParseOptions,
  type TableParseResult,
} from './table.js';

export {
  looksLikeRelativeAbundance,
  parseMetaPhlAn,
  type MetaPhlAnParseOptions,
  type MetaPhlAnParseResult,
} from './metaphlan.js';

export {
  alphaDiversity,
  ALPHA_METRICS,
  chao1,
  COUNT_ONLY_METRICS,
  detectCounts,
  inverseSimpson,
  observed,
  pielou,
  shannon,
  simpson,
  type AlphaMetric,
  type AlphaOptions,
  type AlphaResult,
} from './alpha.js';

export {
  BETA_METRICS,
  betaDiversity,
  brayCurtis,
  euclidean,
  jaccard,
  pcoa,
  permanova,
  symmetricEigen,
  type BetaMetric,
  type BetaOptions,
  type DistanceMatrix,
  type PcoaResult,
  type PermanovaResult,
} from './beta.js';
