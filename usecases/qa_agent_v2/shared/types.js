/**
 * QA Agent v2 — shared types (JSDoc-style typedefs).
 *
 * These are the contracts between the 5 layers:
 *   Layer 1 (Parser)     → produces QueryIntent
 *   Layer 2 (Planner)    → produces ExecutionPlan
 *   Layer 3 (Data)       → produces Row[]
 *   Layer 4 (Aggregator) → produces AnswerData
 *   Layer 5 (Formatter)  → produces { message: string }
 *
 * Every numeric value the user sees comes out of Layer 4. The LLM appears
 * exactly in Layer 1 (parse only — no numbers) and OPTIONALLY in Layer 5
 * (phrasing only — forbidden from modifying numbers).
 */

/**
 * @typedef {Object} TimeWindow
 * @property {'single' | 'range' | 'all_time'} kind
 * @property {string} [start_iso]  - YYYY-MM-DD (required unless kind='all_time')
 * @property {string} [end_iso]    - YYYY-MM-DD (required unless kind='all_time')
 * @property {string} label        - User-facing display ('today', 'last week', '8-14 May 2026')
 */

/**
 * @typedef {Object} Filter
 * @property {string} field
 * @property {'=' | '!=' | 'in' | 'like' | '>=' | '<='} op
 * @property {any} [value]
 * @property {any[]} [values]
 */

/**
 * @typedef {Object} GroupKey
 * @property {string} field
 */

/**
 * @typedef {Object} OrderBy
 * @property {string} field
 * @property {'asc' | 'desc'} dir
 */

/**
 * @typedef {(
 *   'point_lookup' | 'count' | 'aggregate' | 'distribution' | 'trend' |
 *   'comparison' | 'top_n' | 'ranking' | 'ratio' | 'threshold' |
 *   'status' | 'list' | 'gap' | 'unsupported'
 * )} QuestionType
 */

/**
 * @typedef {(
 *   'manpower' | 'safety' | 'soil_disposal' | 'wbgt' | 'noise' |
 *   'piling_progress' | 'im_progress' | 'pile_cap' | 'concrete' | 'document_tracking' |
 *   'document_log' | 'report_generation' | 'unsupported'
 * )} Domain
 */

/**
 * @typedef {'count' | 'sum' | 'avg' | 'min' | 'max'} AggOp
 */

/**
 * @typedef {Object} QueryIntent
 * @property {QuestionType} question_type
 * @property {Domain} domain
 * @property {string} target_metric          - 'headcount' | 'open_count' | 'volume_m3' | 'wbgt_outdoor' | ...
 * @property {TimeWindow} time_window
 * @property {Filter[]} filters
 * @property {GroupKey[]} group_by
 * @property {OrderBy} [order_by]
 * @property {number} [limit]
 * @property {TimeWindow} [comparison_baseline]
 * @property {string} raw_question           - User's verbatim text (for logs only)
 */

/**
 * @typedef {Object} ExecutionPlan
 * @property {Step[]} steps
 * @property {QuestionType} answer_shape     - Tells the formatter which template/AnswerData kind to expect
 * @property {string} [unsupported_reason]   - When question can't be planned
 */

/**
 * @typedef {(
 *   | { kind: 'fetch_rows'; domain: Domain; window: TimeWindow; filters: Filter[]; select?: string[] }
 *   | { kind: 'fetch_wohhup_totals'; window: TimeWindow }
 *   | { kind: 'aggregate'; op: AggOp; field?: string; group_by?: GroupKey[] }
 *   | { kind: 'sort'; by: string; dir: 'asc'|'desc' }
 *   | { kind: 'limit'; n: number }
 *   | { kind: 'compare'; baseline_plan: ExecutionPlan; current_plan: ExecutionPlan }
 * )} Step
 */

/**
 * @typedef {Object} Row
 * Generic row from a data adapter. Fields are domain-specific.
 */

/**
 * @typedef {Object} Meta
 * @property {Domain} domain
 * @property {TimeWindow} time_window
 * @property {Filter[]} filters_applied
 * @property {string[]} sources              - 'manpowerData', 'whatsapp_listener', 'buildWohhupTotals', ...
 * @property {string} generated_at_sgt
 * @property {number} row_count
 * @property {string[]} [notes]              - Data-quality remarks
 */

/**
 * @typedef {(
 *   | { kind: 'point_lookup'; value: number|null; unit?: string; label: string; meta: Meta }
 *   | { kind: 'count'; total: number; breakdown?: BreakdownRow[]; meta: Meta }
 *   | { kind: 'distribution'; total: number; rows: BreakdownRow[]; meta: Meta }
 *   | { kind: 'aggregate'; value: number|null; op: AggOp; field?: string; breakdown?: BreakdownRow[]; meta: Meta }
 *   | { kind: 'trend'; series: TrendPoint[]; total: number; avg_per_period: number; meta: Meta }
 *   | { kind: 'comparison'; baseline: AnswerData; current: AnswerData; delta: number; pct_change: number|null; meta: Meta }
 *   | { kind: 'top_n'; rows: RankedRow[]; total_universe: number; meta: Meta }
 *   | { kind: 'ranking'; winners: RankedRow[]; tiebreaker?: string; meta: Meta }
 *   | { kind: 'ratio'; numerator: number; denominator: number; ratio: number; pct: number; meta: Meta }
 *   | { kind: 'threshold'; over: number; under: number; threshold: number; rows?: BreakdownRow[]; meta: Meta }
 *   | { kind: 'status'; current_state: string; since?: string; meta: Meta }
 *   | { kind: 'list'; rows: Row[]; total: number; truncated: boolean; meta: Meta }
 *   | { kind: 'gap'; missing_keys: string[]; expected_universe: string; meta: Meta }
 *   | { kind: 'unsupported'; reason: string; meta: Meta }
 * )} AnswerData
 */

/**
 * @typedef {Object} BreakdownRow
 * @property {string} key                    - e.g. 'P1', 'KTC', 'LT SAMBO'
 * @property {number} value
 * @property {BreakdownRow[]} [sub]          - Nested (e.g., P1 → {open: 3, closed: 5})
 */

/**
 * @typedef {Object} TrendPoint
 * @property {string} period_label           - 'Mon 04-May-2026'
 * @property {string} period_iso             - '2026-05-04'
 * @property {number} value
 * @property {Object} [extras]               - Domain-specific extra fields (E/S/W for Wohhup)
 */

/**
 * @typedef {Object} RankedRow
 * @property {number} rank
 * @property {string} key
 * @property {number} value
 */

/**
 * @typedef {Object} MetricDef
 * @property {string} name                   - 'headcount', 'engineer_count'
 * @property {string} [field]                - Underlying row field
 * @property {string} [unit]                 - 'count' | 'pax' | 'm³' | 'usd' | '°C' | 'dBA'
 * @property {AggOp[]} aggregations
 * @property {(rows: Row[]) => number} [derived]
 * @property {Filter[]} [filterDefault]
 */

/**
 * @typedef {Object} DimensionDef
 * @property {string} name
 * @property {string[]} [enum]
 * @property {'date' | 'category' | 'text' | 'numeric_bucket'} semantic_type
 */

/**
 * @typedef {Object} DomainPlugin
 * @property {Domain} name
 * @property {string} displayName
 * @property {string} description
 * @property {MetricDef[]} metrics
 * @property {DimensionDef[]} dimensions
 * @property {(opts: {window: TimeWindow, filters: Filter[], select?: string[], groupConfig?: any}) => Promise<Row[]>} fetchRows
 * @property {(opts: any) => Promise<any>} [fetchAggregate]
 * @property {Record<string, string>} [glossary]
 */

module.exports = {}; // type-only file
