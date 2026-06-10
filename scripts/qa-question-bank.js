// Single source of truth for QA-agent consistency / accuracy testing.
//
// Each entry:
//   id              — short stable id (use this to look up failing cases in logs)
//   domain          — the domain we expect the parser to classify into
//   question        — the question text as the user would type it
//   expected_type   — (optional) the QueryIntent.question_type the parser should produce
//                     (count, aggregate, distribution, trend, comparison, top_n, ranking,
//                      ratio, threshold, status, list, gap, point_lookup, unsupported)
//   expected_metric — (optional) the QueryIntent.target_metric the parser should produce
//   forbidden       — array of substrings that MUST NOT appear in any run's answer.
//                     Default: implementation-leak strings like "will be updated".
//   notes           — optional human notes (not asserted)
//
// Tests verify:
//   1. All 5 runs of one question are BYTE-IDENTICAL (Set size === 1).
//   2. No forbidden substring appears in any answer.
//   3. Primary numeric value matches an independent SQL/JS ground truth.
//   4. Paraphrased variants (LLM-generated) produce the same QueryIntent fingerprint.

const FORBIDDEN_DEFAULTS = [
  "will be updated automatically",
  "Total includes all companies",
  "All workers are on day shift today",
  "Note:",
  "(Woh Hup total will",
];

// Curated smoke subset — hand-picked entries that exercise every
// question_type AND every bypass at least once. Run via:
//   node scripts/test-v2-consistency.js --smoke
// ~17 questions × 5 runs ≈ 2 min. Catches every cross-cutting break
// (parser-prompt drift, planner regressions, bypass dispatch failures)
// without the full-bank wall-clock cost. NOT a replacement for the full
// bank — full bank is still the pre-deploy gate. This is the inner-loop
// check while iterating on prompt rules or shared helpers.
//
// To add a new id: append it AND verify the full-bank still passes
// 168/168 first (otherwise the smoke is asserting something the full
// bank doesn't already cover).
const SMOKE_IDS = Object.freeze(
  new Set([
    // — every question_type, picked from established passing entries —
    "mp_listing_today", // aggregate
    "safety_by_severity", // distribution
    "mp_top5_companies", // top_n
    "mp_ranking_most", // ranking
    "mp_trend_past_7d", // trend
    "safety_compare_weeks", // comparison
    "safety_open_yesterday", // count + filter
    "safety_closed_pct", // ratio
    "wbgt_threshold_31", // threshold
    "piling_p211_status", // list (also tests piling_progress domain)
    "cj8_status", // status (also tests pile_cap domain)
    // — analytical domains not yet covered by the type picks above —
    "soil_trips_today", // domain:soil_disposal
    "noise_peak_today", // domain:noise
    "im_today_summary", // domain:im_progress
    "doc_incoming_today", // domain:document_tracking
    "concrete_progress_today", // domain:concrete (per-location casting status)
    "concrete_casting_status", // domain:concrete (template-layout casting card)
    // — every bypass plugin —
    "safety_summary", // bypass: report_generation (canonical cron msg)
    "safety_image_open_today", // bypass: safety_image (screenshot)
    "ns_sync_today", // bypass: novade_sync (preview step)
    "doc_outstanding_arena", // bypass: master_register_image
    // — counter-examples (must NOT bypass-route) —
    "ns_counter_no_novade_kw", // 'how many safety issues today' must stay analytical
    // — recent-bug regression guard (added 2026-05-29 after the "latest" bug) —
    "safety_compound_3way", // exercises compound + inline-severity renderer
  ]),
);

const BANK = [
  // ───────────────────────────── MANPOWER ─────────────────────────────
  // Multi-company site-wide listing (the original failing case)
  {
    id: "mp_listing_today",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "how many manpower today?",
  },
  {
    id: "mp_listing_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "how many manpower yesterday?",
  },
  {
    id: "mp_listing_explicit_iso",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "how many manpower on 2026-05-09?",
  },
  {
    id: "mp_listing_explicit_ddmmm",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "how many manpower on 9-May-2026",
  },
  {
    id: "mp_listing_alt_site",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "site headcount today",
  },
  {
    id: "mp_listing_alt_total",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "total manpower on 9-May-2026",
  },
  {
    id: "mp_listing_alt_all",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "how many workers across all companies today",
  },

  // Wohhup-specific 3-bucket
  {
    id: "wh_total_today",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "wohhup manpower today",
  },
  {
    id: "wh_total_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "headcount",
    question: "WH manpower yesterday",
  },
  {
    id: "wh_engineer_today",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "engineer_count",
    question: "wohhup engineers today",
  },
  {
    id: "wh_staff_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "staff_count",
    question: "wohhup staff yesterday",
  },
  {
    id: "wh_worker_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "worker_count",
    question: "wohhup workers yesterday",
  },

  // Wohhup TS/NTS
  {
    id: "wh_tsnts_today",
    domain: "manpower",
    expected_type: "distribution",
    expected_metric: "staff_count",
    question: "wohhup TS and NTS today",
  },
  {
    id: "wh_ts_only",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "ts_count",
    question: "WH TS today",
  },
  {
    id: "wh_nts_only",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "nts_count",
    question: "WH NTS today",
  },

  // Wohhup workers register
  {
    id: "wh_on_site_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "on_site_count",
    question: "wohhup workers on site yesterday",
  },
  {
    id: "wh_home_leave_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "home_leave_count",
    question: "wohhup workers on home leave yesterday",
  },
  {
    id: "wh_loan_out_yesterday",
    domain: "manpower",
    expected_type: "aggregate",
    expected_metric: "loan_out_count",
    question: "wohhup workers loaned out yesterday",
  },

  // Distribution / ranking / trend
  {
    id: "mp_by_company_explicit",
    domain: "manpower",
    expected_type: "distribution",
    expected_metric: "headcount",
    question: "manpower on 2026-05-08 broken down by company",
  },
  {
    id: "mp_by_company_role",
    domain: "manpower",
    expected_type: "distribution",
    expected_metric: "headcount",
    question: "how many manpower on 2026-05-08? breakdown by company and role",
  },
  {
    id: "mp_by_role_only",
    domain: "manpower",
    expected_type: "distribution",
    expected_metric: "headcount",
    question: "manpower by role on 2026-05-08",
  },
  {
    id: "mp_top5_companies",
    domain: "manpower",
    expected_type: "top_n",
    expected_metric: "headcount",
    question: "top 5 subcontractors by headcount on 2026-05-08",
  },
  {
    id: "mp_ranking_most",
    domain: "manpower",
    expected_type: "ranking",
    expected_metric: "headcount",
    question: "which company has the most manpower on 2026-05-08",
  },
  {
    id: "mp_trend_past_7d",
    domain: "manpower",
    expected_type: "trend",
    expected_metric: "headcount",
    question: "manpower per day over the past 7 days",
  },
  {
    id: "mp_compare_weeks",
    domain: "manpower",
    expected_type: "comparison",
    expected_metric: "headcount",
    question: "manpower this week vs last week",
  },

  // ────────────────────────────── SAFETY ──────────────────────────────
  {
    id: "safety_open_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "open_count",
    question: "how many open issues yesterday",
  },
  {
    id: "safety_closed_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "closed_count",
    question: "how many closed issues yesterday",
  },
  {
    id: "safety_total_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many total issues reported yesterday",
  },
  {
    id: "safety_goodobs_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many good observations yesterday",
  },
  {
    id: "safety_p1_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many P1 issues yesterday",
  },
  {
    id: "safety_p2_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many P2 issues yesterday",
  },
  {
    id: "safety_open_explicit",
    domain: "safety",
    expected_type: "count",
    expected_metric: "open_count",
    question: "how many open issues on 2026-05-08?",
  },
  {
    id: "safety_total_explicit",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many issues reported on 2026-05-08?",
  },
  {
    id: "safety_by_severity",
    domain: "safety",
    expected_type: "distribution",
    expected_metric: "issue_count",
    question: "breakdown of safety issues by severity on 2026-05-08",
  },
  {
    id: "safety_compound_3way",
    domain: "safety",
    expected_type: "distribution",
    expected_metric: "issue_count",
    question: "how many total issues reported on 2026-05-08? how many closed? breakdown by severity",
  },
  {
    id: "safety_summary",
    domain: "safety",
    expected_type: "distribution",
    expected_metric: "issue_count",
    question: "safety summary on 2026-05-08",
  },
  {
    id: "safety_by_status",
    domain: "safety",
    expected_type: "distribution",
    expected_metric: "issue_count",
    question: "safety issues by status on 2026-05-08",
  },
  {
    id: "safety_closed_pct",
    domain: "safety",
    expected_type: "ratio",
    expected_metric: "closed_rate",
    question: "what percentage of safety issues are closed on 2026-05-08?",
  },
  {
    id: "safety_trend_past_week",
    domain: "safety",
    expected_type: "trend",
    expected_metric: "issue_count",
    question: "safety issues per day for the past 7 days",
  },
  {
    id: "safety_compare_weeks",
    domain: "safety",
    expected_type: "comparison",
    expected_metric: "issue_count",
    question: "safety issues this week vs last week",
  },

  // ─────────────────────────── SOIL DISPOSAL ──────────────────────────
  {
    id: "soil_trips_today",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many trips today",
  },
  {
    id: "soil_truck_loads_today",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many truck loads today?",
  },
  {
    id: "soil_truck_loads_explicit",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many truck loads on 2026-05-08?",
  },
  {
    id: "soil_lorry_trips",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many lorry trips on 2026-05-08",
  },
  {
    id: "soil_spoil_removal",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "spoil removal today",
  },
  {
    id: "soil_loads_yesterday",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many soil disposal loads yesterday",
  },
  {
    id: "soil_volume_explicit",
    domain: "soil_disposal",
    expected_type: "aggregate",
    expected_metric: "volume_m3",
    question: "total soil disposal volume on 2026-05-08",
  },
  {
    id: "soil_ktc_only",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many KTC trips on 2026-05-08",
  },
  {
    id: "soil_kkl_only",
    domain: "soil_disposal",
    expected_type: "count",
    expected_metric: "trip_count",
    question: "how many KKL trips on 2026-05-08",
  },
  {
    id: "soil_trips_per_subcon",
    domain: "soil_disposal",
    expected_type: "distribution",
    expected_metric: "trip_count",
    question: "how many trips per subcon on 2026-05-08",
  },
  {
    id: "soil_volume_per_subcon",
    domain: "soil_disposal",
    expected_type: "distribution",
    expected_metric: "volume_m3",
    question: "soil disposal volume per subcon on 2026-05-08",
  },
  {
    id: "soil_trips_trend",
    domain: "soil_disposal",
    expected_type: "trend",
    expected_metric: "trip_count",
    question: "trips per day from 2026-05-04 to 2026-05-08",
  },
  {
    id: "soil_volume_trend",
    domain: "soil_disposal",
    expected_type: "trend",
    expected_metric: "volume_m3",
    question: "soil disposal volume per day from 2026-05-04 to 2026-05-08",
  },
  {
    id: "soil_top_trucks",
    domain: "soil_disposal",
    expected_type: "top_n",
    expected_metric: "trip_count",
    question: "top 5 carplates by trips on 2026-05-08",
  },
  {
    id: "soil_dumping_distribution",
    domain: "soil_disposal",
    expected_type: "distribution",
    expected_metric: "trip_count",
    question: "soil disposal trips per dumping ground on 2026-05-08",
  },

  // ─────────────────────────────── WBGT ───────────────────────────────
  {
    id: "wbgt_today_avg",
    domain: "wbgt",
    expected_type: "aggregate",
    expected_metric: "wbgt_outdoor",
    question: "average WBGT on 2026-05-08",
  },
  {
    id: "wbgt_explicit_peak",
    domain: "wbgt",
    expected_type: "aggregate",
    expected_metric: "wbgt_outdoor",
    question: "what was the peak WBGT on 2026-05-08?",
  },
  {
    id: "wbgt_explicit_min",
    domain: "wbgt",
    expected_type: "aggregate",
    expected_metric: "wbgt_outdoor",
    question: "what was the lowest WBGT on 2026-05-08?",
  },
  {
    id: "wbgt_hourly_dist",
    domain: "wbgt",
    expected_type: "distribution",
    expected_metric: "wbgt_outdoor",
    question: "show me hourly WBGT readings on 2026-05-08",
  },
  {
    id: "wbgt_count_readings",
    domain: "wbgt",
    expected_type: "count",
    expected_metric: "reading_count",
    question: "how many WBGT readings on 2026-05-08",
  },
  {
    id: "wbgt_threshold_31",
    domain: "wbgt",
    expected_type: "threshold",
    expected_metric: "wbgt_outdoor",
    question: "how many readings were above 31 degrees on 2026-05-08?",
  },
  {
    id: "wbgt_threshold_32",
    domain: "wbgt",
    expected_type: "threshold",
    expected_metric: "wbgt_outdoor",
    question: "how many WBGT readings above 32 degrees on 2026-05-08",
  },
  {
    id: "wbgt_trend_past_5",
    domain: "wbgt",
    expected_type: "trend",
    expected_metric: "wbgt_outdoor",
    question: "WBGT trend per day from 2026-05-04 to 2026-05-08",
  },
  {
    id: "wbgt_compare_dates",
    domain: "wbgt",
    expected_type: "comparison",
    expected_metric: "wbgt_outdoor",
    question: "compare average WBGT between 2026-05-07 and 2026-05-08",
  },
  {
    id: "wbgt_morning_avg",
    domain: "wbgt",
    expected_type: "aggregate",
    expected_metric: "wbgt_outdoor",
    question: "average WBGT between 8am and 12pm on 2026-05-08",
  },

  // ─────────────────────────────── NOISE ──────────────────────────────
  {
    id: "noise_today_avg",
    domain: "noise",
    expected_type: "aggregate",
    expected_metric: "leq_5min",
    question: "average noise level on 2026-05-08",
  },
  {
    id: "noise_peak_today",
    domain: "noise",
    expected_type: "aggregate",
    expected_metric: "leq_5min",
    question: "what was the peak noise level on 2026-05-08?",
  },
  {
    id: "noise_nm1_avg",
    domain: "noise",
    expected_type: "aggregate",
    expected_metric: "leq_5min",
    question: "average noise at NM1 on 2026-05-08",
  },
  {
    id: "noise_nm2_avg",
    domain: "noise",
    expected_type: "aggregate",
    expected_metric: "leq_5min",
    question: "average noise at NM2 on 2026-05-08",
  },
  {
    id: "noise_count_readings",
    domain: "noise",
    expected_type: "count",
    expected_metric: "reading_count",
    question: "how many noise readings on 2026-05-08",
  },
  {
    id: "noise_hourly_nm1",
    domain: "noise",
    expected_type: "distribution",
    expected_metric: "leq_5min",
    question: "hourly noise levels at NM1 on 2026-05-08",
  },
  {
    id: "noise_compare_locations",
    domain: "noise",
    expected_type: "distribution",
    expected_metric: "leq_5min",
    question: "compare average noise between NM1 and NM2 on 2026-05-08",
  },
  {
    id: "noise_threshold_75",
    domain: "noise",
    expected_type: "threshold",
    expected_metric: "leq_5min",
    question: "how many noise readings above 75 dBA on 2026-05-08",
  },
  {
    id: "noise_max_hour_nm1",
    domain: "noise",
    expected_type: "ranking",
    expected_metric: "leq_5min",
    question: "loudest hour at NM1 on 2026-05-08",
  },
  {
    id: "noise_trend_past_5",
    domain: "noise",
    expected_type: "trend",
    expected_metric: "leq_5min",
    question: "average noise per day from 2026-05-04 to 2026-05-08",
  },

  // ──────────────────────── PILING PROGRESS ───────────────────────────
  {
    id: "piling_today_summary",
    domain: "piling_progress",
    expected_type: "distribution",
    expected_metric: "completed_count",
    question: "show me today piling progress summary",
  },
  {
    id: "piling_dwall_completed",
    domain: "piling_progress",
    expected_type: "aggregate",
    expected_metric: "completed_count",
    question: "how many D-Wall completed on 2026-05-08?",
  },
  {
    id: "piling_barrette_completed",
    domain: "piling_progress",
    expected_type: "aggregate",
    expected_metric: "completed_count",
    question: "how many Barrette Pile completed on 2026-05-08?",
  },
  {
    id: "piling_cross_wall_pct",
    domain: "piling_progress",
    expected_type: "ratio",
    expected_metric: "completion",
    question: "what percentage of cross-wall is completed on 2026-05-08?",
  },
  {
    id: "piling_bored_pile",
    domain: "piling_progress",
    expected_type: "aggregate",
    expected_metric: "completed_count",
    question: "how many bored piles completed on 2026-05-08?",
  },
  {
    id: "piling_jgp_progress",
    domain: "piling_progress",
    expected_type: "distribution",
    expected_metric: "completed_count",
    question: "what is the JGP progress on 2026-05-08?",
  },
  {
    id: "piling_p211_status",
    domain: "piling_progress",
    expected_type: "list",
    expected_metric: "pile_count",
    question: "what is the progress of P211 on 2026-05-08?",
  },
  {
    id: "piling_bp94_depth",
    domain: "piling_progress",
    expected_type: "aggregate",
    expected_metric: "current_depth_m",
    question: "how deep is BP94 on 2026-05-08?",
  },
  {
    id: "piling_d2400_list",
    domain: "piling_progress",
    expected_type: "list",
    expected_metric: "pile_count",
    question: "show all D2400 piles on 2026-05-08",
  },
  {
    id: "piling_pile_count_today",
    domain: "piling_progress",
    expected_type: "count",
    expected_metric: "pile_count",
    question: "how many individual piles reported on 2026-05-08?",
  },
  {
    id: "piling_compare_dates",
    domain: "piling_progress",
    expected_type: "comparison",
    expected_metric: "completed_count",
    question: "compare D-Wall progress between 2026-05-07 and 2026-05-08",
  },
  {
    id: "piling_lowest_pct",
    domain: "piling_progress",
    expected_type: "ranking",
    expected_metric: "completion",
    question: "which work type has the lowest completion percentage on 2026-05-08?",
  },

  // ──────────────────────────── IM PROGRESS ───────────────────────────
  {
    id: "im_today_summary",
    domain: "im_progress",
    expected_type: "distribution",
    expected_metric: "completed_count",
    question: "show me IM progress on 2026-05-08",
  },
  {
    id: "im_iw_completed",
    domain: "im_progress",
    expected_type: "aggregate",
    expected_metric: "completed_count",
    question: "how many IW completed on 2026-05-08?",
  },
  {
    id: "im_gws_completed",
    domain: "im_progress",
    expected_type: "aggregate",
    expected_metric: "completed_count",
    question: "how many GWS completed on 2026-05-08?",
  },
  {
    id: "im_sg_completed",
    domain: "im_progress",
    expected_type: "aggregate",
    expected_metric: "completed_count",
    question: "how many strain gauges completed on 2026-05-08?",
  },
  {
    id: "im_iw_pct",
    domain: "im_progress",
    expected_type: "ratio",
    expected_metric: "completion",
    question: "what percentage of IW is completed on 2026-05-08?",
  },
  {
    id: "im_lowest_pct",
    domain: "im_progress",
    expected_type: "ranking",
    expected_metric: "completion",
    question: "which instrument type has the lowest completion percentage on 2026-05-08?",
  },
  {
    id: "im_active_rigs",
    domain: "im_progress",
    expected_type: "list",
    expected_metric: "activity_count",
    question: "what rigs are active on 2026-05-08?",
  },
  {
    id: "im_rig1_activity",
    domain: "im_progress",
    expected_type: "list",
    expected_metric: "activity_count",
    question: "what is rig1 working on 2026-05-08?",
  },
  {
    id: "im_iw3008_status",
    domain: "im_progress",
    expected_type: "status",
    expected_metric: "activity_count",
    question: "what is the status of IW3008 on 2026-05-08?",
  },
  {
    id: "im_compare_dates",
    domain: "im_progress",
    expected_type: "comparison",
    expected_metric: "completed_count",
    question: "compare IW progress between 2026-05-07 and 2026-05-08",
  },
  {
    id: "im_count_activities",
    domain: "im_progress",
    expected_type: "count",
    expected_metric: "activity_count",
    question: "how many IM activities on 2026-05-08?",
  },

  // ────────────────────────────── PILE CAP ────────────────────────────
  {
    id: "cj_summary_today",
    domain: "pile_cap",
    expected_type: "distribution",
    expected_metric: "update_count",
    question: "show me pile cap progress on 2026-05-08",
  },
  {
    id: "cj8_status",
    domain: "pile_cap",
    expected_type: "status",
    expected_metric: "update_count",
    question: "what is the status of CJ8 on 2026-05-08?",
  },
  {
    id: "cj_in_progress",
    domain: "pile_cap",
    expected_type: "list",
    expected_metric: "in_progress_count",
    question: "which CJs are in progress on 2026-05-08?",
  },
  {
    id: "cj_completed_rebar",
    domain: "pile_cap",
    expected_type: "list",
    expected_metric: "completed_count",
    question: "which CJs have completed rebar on 2026-05-08?",
  },
  {
    id: "cj_doing_formwork",
    domain: "pile_cap",
    expected_type: "list",
    expected_metric: "in_progress_count",
    question: "which CJs are doing formwork on 2026-05-08?",
  },
  {
    id: "cj_ready_for_casting",
    domain: "pile_cap",
    expected_type: "list",
    expected_metric: "completed_count",
    question: "any CJ ready for casting on 2026-05-08?",
  },
  {
    id: "cj_completed_casting",
    domain: "pile_cap",
    expected_type: "list",
    expected_metric: "completed_count",
    question: "any CJ completed casting on 2026-05-08?",
  },
  {
    id: "cj_by_stage",
    domain: "pile_cap",
    expected_type: "distribution",
    expected_metric: "update_count",
    question: "pile cap updates by stage on 2026-05-08",
  },
  {
    id: "cj_count_today",
    domain: "pile_cap",
    expected_type: "count",
    expected_metric: "update_count",
    question: "how many CJ updates on 2026-05-08?",
  },
  {
    id: "cj_compare_dates",
    domain: "pile_cap",
    expected_type: "comparison",
    expected_metric: "update_count",
    question: "compare CJ activity between 2026-05-07 and 2026-05-08",
  },

  // ────────────────────────────── CONCRETE ────────────────────────────
  // Per-location concrete casting status (cast volume vs total order). status type.
  {
    id: "concrete_progress_today",
    domain: "concrete",
    expected_type: "status",
    expected_metric: "casting_status",
    question: "what is the concrete progress for 01TB154",
  },
  {
    id: "concrete_casting_status",
    domain: "concrete",
    expected_type: "status",
    expected_metric: "casting_status",
    question: "casting status at 01TB154",
  },
  {
    id: "concrete_progress_explicit_date",
    domain: "concrete",
    expected_type: "status",
    expected_metric: "casting_status",
    question: "what is the concrete progress for 01TB154 on 2026-05-08",
  },
  {
    id: "concrete_progress_range",
    domain: "concrete",
    expected_type: "status",
    expected_metric: "casting_status",
    question: "concrete progress for 01TB154 from 2026-05-04 to 2026-05-08",
  },
  {
    id: "concrete_how_much_cast",
    domain: "concrete",
    expected_type: "status",
    expected_metric: "casting_status",
    question: "how much concrete cast for 01TB154 today",
  },

  // ────────────────────────── DOCUMENT TRACKING ───────────────────────
  // Daily flow
  {
    id: "doc_incoming_today",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "what is the incoming documents for today",
  },
  {
    id: "doc_outgoing_today",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "what documents did we send today",
  },
  {
    id: "doc_all_today",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "today's document log summary",
  },
  {
    id: "doc_count_yesterday",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "document_count",
    question: "how many documents yesterday",
  },
  // Due / SLA / overdue
  {
    id: "doc_due_this_week_rfi_rfa_ms",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "open_count",
    question: "list down all the RFI/RFA/MS which due this week",
  },
  {
    id: "doc_overdue_all",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "overdue_count",
    question: "what documents are overdue?",
  },
  {
    id: "doc_overdue_rfi",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "overdue_count",
    question: "any overdue RFIs?",
  },
  {
    id: "doc_overdue_count",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "overdue_count",
    question: "how many overdue documents?",
  },
  {
    id: "doc_due_next_7_days_rfi",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "due_this_week_count",
    question: "RFIs due in the next 7 days",
  },
  // Open / closed
  {
    id: "doc_open_rfis",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "open_count",
    question: "list all open RFIs",
  },
  {
    id: "doc_open_count",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "open_count",
    question: "how many open documents?",
  },
  {
    id: "doc_closed_this_week",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "closed_count",
    question: "how many documents got closed this week?",
  },
  // Location-filtered queries — exercises the Location dimension added to
  // document_tracking. Covers the DC requirement "Query for outstanding docs
  // for specific locations". Locations come straight from the WHP doc code's
  // 3rd segment (ARN→Arena, BSM→Basement, POD→Podium, EXT→External, MRT→MRT).
  //
  // NOTE 2026-05-22: "outstanding [X] for [Y]" patterns now route to the
  // master_register_image bypass (returns a sheet screenshot), per customer
  // request to surface the actual register with red/yellow highlights instead
  // of a text list. Phrasings using "open" (not "outstanding") stay on
  // document_tracking — they're functionally equivalent but the customer's
  // trigger word is specifically "outstanding".
  {
    id: "doc_outstanding_arena",
    domain: "master_register_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "outstanding RFIs in Arena",
  },
  {
    id: "doc_open_basement",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "open_count",
    question: "open documents for Basement",
  },
  {
    id: "doc_overdue_podium",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "overdue_count",
    question: "any overdue RFI at Podium",
  },
  {
    id: "doc_rfis_external",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "open_count",
    question: "list RFIs in External",
  },
  {
    id: "doc_count_arena",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "open_count",
    question: "how many outstanding documents in Arena?",
  },
  // Volume / counts
  {
    id: "doc_rfi_count_week",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "document_count",
    question: "how many RFIs this week",
  },
  {
    id: "doc_rfa_count_month",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "document_count",
    question: "how many RFAs this month",
  },
  {
    id: "doc_transmittals_today",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "document_count",
    question: "how many transmittals sent today",
  },
  {
    id: "doc_ms_count_month",
    domain: "document_tracking",
    expected_type: "count",
    expected_metric: "document_count",
    question: "how many method statements submitted this month",
  },
  // Breakdowns / distributions
  {
    id: "doc_by_type_today",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "document breakdown by type today",
  },
  {
    id: "doc_by_sender_this_week",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "documents by sender this week",
  },
  {
    id: "doc_by_direction_this_week",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "outgoing vs incoming documents this week",
  },
  {
    id: "doc_compound_summary",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "documents this week: how many sent, how many received, breakdown by type",
  },
  // Trends / comparisons
  {
    id: "doc_volume_trend_7d",
    domain: "document_tracking",
    expected_type: "trend",
    expected_metric: "document_count",
    question: "document volume per day for the past 7 days",
  },
  {
    id: "doc_rfi_trend_month",
    domain: "document_tracking",
    expected_type: "trend",
    expected_metric: "document_count",
    question: "RFI volume per day from 2026-05-04 to 2026-05-12",
  },
  {
    id: "doc_compare_weeks",
    domain: "document_tracking",
    expected_type: "comparison",
    expected_metric: "document_count",
    question: "documents this week vs last week",
  },
  // Ranking / top-N
  {
    id: "doc_top_senders_week",
    domain: "document_tracking",
    expected_type: "top_n",
    expected_metric: "document_count",
    question: "top 5 senders by document volume this week",
  },
  {
    id: "doc_slowest_open_rfi",
    domain: "document_tracking",
    expected_type: "ranking",
    expected_metric: "days_open",
    question: "which RFI has been open the longest?",
  },
  // Threshold
  {
    id: "doc_overdue_over_7d",
    domain: "document_tracking",
    expected_type: "threshold",
    expected_metric: "days_open",
    question: "RFIs overdue by more than 7 days",
  },
  // Ratio
  {
    id: "doc_rfi_closed_pct",
    domain: "document_tracking",
    expected_type: "ratio",
    expected_metric: "closed_count",
    question: "what percentage of RFIs are closed this month?",
  },
  // Status / point lookup
  {
    id: "doc_status_specific_rfi",
    domain: "document_tracking",
    expected_type: "status",
    expected_metric: "document_count",
    question: "status of RFI WHP-MBS2-RFI-000141",
  },
  {
    id: "doc_transmittal_lookup",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "document_count",
    question: "show me transmittal WHP-MBS2-TRANSMIT-000209",
  },
  // Filter combo: by sender + direction
  {
    id: "doc_arup_this_week",
    domain: "document_tracking",
    expected_type: "distribution",
    expected_metric: "document_count",
    question: "documents from Arup this week",
  },
  // CN / RIN / PMI — customer-requested phrasings (DC, 2026-05).
  {
    id: "doc_cn_replies",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "cn_reply_count",
    question: "show me all document with CN replies",
  },
  {
    id: "doc_rin_closed_inspection",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "rin_closed_count",
    question: "show me all RIN closed inspection form",
  },
  {
    id: "doc_pmi_list",
    domain: "document_tracking",
    expected_type: "list",
    expected_metric: "pmi_count",
    question: "show me all PMI",
  },
  // Master register image bypass — "outstanding [doctype]? for [location]"
  // pattern from the customer's 2026-05 QA agent requirement. Returns a
  // screenshot of the Master Document Register filtered to the requested
  // scope (1-3 WhatsApp images, not text).
  {
    id: "mdr_image_outstanding_rfi_arena",
    domain: "master_register_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "outstanding rfi for Arena",
  },
  {
    id: "mdr_image_outstanding_rin_basement",
    domain: "master_register_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "outstanding rin for Basement",
  },
  {
    id: "mdr_image_outstanding_docs_arena",
    domain: "master_register_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "outstanding docs for Arena",
  },
  // Safety image bypass — "send screenshot" pattern with date + status filter.
  // Returns a screenshot of the Safety Google Sheet instead of a text count.
  {
    id: "safety_image_open_today",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of open issues today in safety sheet",
  },
  {
    id: "safety_image_open_no_date",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of open issues in safety sheet",
  },
  {
    id: "safety_image_p1_yesterday",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of P1 issues yesterday in safety",
  },
  {
    id: "safety_image_explicit_date",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of closed issues on 2026-05-18 in safety",
  },
  // Same questions WITHOUT the "in safety [sheet]?" suffix — must route to
  // safety_image identically. The "in safety" suffix is decorative.
  {
    id: "safety_image_open_today_short",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of open issues today",
  },
  {
    id: "safety_image_p1_yesterday_short",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of P1 issues yesterday",
  },
  {
    id: "safety_image_explicit_date_short",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of closed issues on 2026-05-18",
  },
  // Range support — last week / last month / this week / explicit date range.
  {
    id: "safety_image_open_last_week",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of open safety issues last week",
  },
  {
    id: "safety_image_open_last_month",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of open safety issues last month",
  },
  {
    id: "safety_image_p1_this_week",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of P1 issues this week",
  },
  {
    id: "safety_image_explicit_range",
    domain: "safety_image",
    expected_type: "unsupported",
    expected_metric: "",
    question: "send screenshot of all issues from 2026-05-15 to 2026-05-18",
  },

  // ─────────────────────── NOVADE SYNC (bypass) ───────────────────────
  // Bypass returns no message via v2 (handler runs only at legacy entry),
  // so all 5 runs see <empty> from v2.handleQuestion → byte-identical.
  {
    id: "ns_sync_today",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "sync safety issues today to novade",
  },
  {
    id: "ns_sync_yesterday",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "sync yesterday's safety issues to novade",
  },
  {
    id: "ns_sync_range",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "sync safety issues from 2026-05-15 to 2026-05-18 to novade",
  },
  {
    id: "ns_sync_severity",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "sync P1 safety issues last week to novade",
  },
  {
    id: "ns_status_sheet_today",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "have all safety issues today been synced to novade",
  },
  {
    id: "ns_status_unsynced",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "how many safety issues today are not yet synced to novade",
  },
  {
    id: "ns_status_novade",
    domain: "novade_sync",
    expected_type: "unsupported",
    expected_metric: "",
    question: "novade action status of closed safety issues today",
  },
  // Counter-example — must STAY on analytical safety (no novade keyword).
  {
    id: "ns_counter_no_novade_kw",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many safety issues today",
  },

  // ─────── COVERAGE GAPS / REGRESSION GUARDS (added 2026-05-29) ───────
  // These exercise parser rules added today to fix specific production
  // bugs. Each one is a guard — if it breaks, a previously-fixed bug has
  // regressed and the same wrong customer behavior will reappear.

  // "latest" / "most recent" / "newest" → type=list with order_by Created
  // Timestamp desc + limit. Previously mis-parsed as top_n (needs group_by)
  // → planner rejected → user got "I can answer about..." fallback.
  {
    id: "safety_latest_p1_yesterday",
    domain: "safety",
    expected_type: "list",
    expected_metric: "issue_count",
    question: "show me the latest P1 issue yesterday",
  },
  {
    id: "safety_latest_go_yesterday",
    domain: "safety",
    expected_type: "list",
    expected_metric: "issue_count",
    question: "show me the latest good observation yesterday",
  },
  {
    id: "safety_latest_3_today",
    domain: "safety",
    expected_type: "list",
    expected_metric: "issue_count",
    question: "latest 3 safety issues today",
  },
  {
    id: "safety_most_recent_open",
    domain: "safety",
    expected_type: "list",
    expected_metric: "issue_count",
    question: "most recent open issue",
  },

  // "oldest" / "earliest" / "first" → type=list with order_by asc + limit=1.
  {
    id: "safety_oldest_open_week",
    domain: "safety",
    expected_type: "list",
    expected_metric: "issue_count",
    question: "oldest open issue this week",
  },
  {
    id: "safety_first_today",
    domain: "safety",
    expected_type: "list",
    expected_metric: "issue_count",
    question: "first safety issue today",
  },

  // Dual-filter guard: when user says "X category" / "X type" where X is a
  // known Severity value, parser must emit ONE Severity filter (NOT also a
  // Category filter — that AND narrows to zero rows even when there are
  // matches). See parser system-prompt rule §7a.
  {
    id: "safety_go_category_yesterday",
    domain: "safety",
    expected_type: "count",
    expected_metric: "issue_count",
    question: "how many Good Observation category issues yesterday",
  },
];

module.exports = {
  BANK,
  FORBIDDEN_DEFAULTS,
  SMOKE_IDS,
};
