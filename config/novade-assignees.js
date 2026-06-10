// Per-project Novade assignee list — used by safety_novade_sync to resolve
// WhatsApp display names from the sheet's `Sender` / `Updated By` columns
// against the project's actual assigned-people list. Without this, the fuzzy
// matcher's source is just past-action history (small + can be polluted by
// lenient `lodgedby` strings), and most closer names fall back to
// NOVADE_DEFAULT_ACTOR.
//
// Source: scraped from Novade Safety-HSE UI Assignees combo-list on 2026-05-07.
// To refresh: open project in Novade UI → Safety-HSE → Assignees → "All" filter,
// copy the visible names. Names already in this list don't need re-adding.
//
// What's in vs. what's excluded:
//   - USERS: real human assignees (the only kind Novade accepts as
//     confirmedby/completedby/closedby) — included.
//   - COMPANIES (CGW, KTC, Woh Hup Pte Ltd, etc.) — used as `contractorid`
//     via /people/companies, NOT as actor strings. Excluded here.
//   - GROUPS (Approvers, WSHE, Subcon, etc.) — organizational labels, not
//     individual closers. Excluded.

const HVS_USERS = [
  "Zulkarnain",
  "Chan Yang Shou David",
  "Goh Hock Jin",
  "Wang Ge Wei",
  "Ng Han Liang",
  "Fong Kah Hoe",
  "Looi You Eng",
  "Ye Min Tun",
  "Pang Kean Teng",
  "Lok Shen Jun",
  "Ng Siang Yew",
  "Balakrishnan Aravindh",
  "Tang Jun Yuen",
  "Nguyen Pham Tuan Ngoc",
  "Ragupathy Ezhilarasan",
  "Aung Ko Lin",
  "Rengasamy Muthukumar",
  "Mohamed Shafiee Bin Mohamed Salim",
  "Steven Tan tat Khiang",
  "Krishnan Sakthivel",
  "Stanely Zhang Wenhao",
  "Rengasamy Murugesan",
  "Periyasamy Raja",
  "Chokkar Subbiah",
  "Teddy Ting Tiew Mee",
  "Kalyanasundaram Sathish",
  "Ramanujam Ramesh",
  "SAKTHI RAJAGOPAL",
  "Test WH",
  "WL API",
  "Test Maincon",
  "Test Subcon",
  "Test Operator",
  "Lucas Tay Zhan Hon",
  "Subramani Natesan",
  "MIA ILIAS",
  "PACKIASAMY MANI",
  "MIRZA SHOHAG",
  "HOSSAIN ALAMGIR",
  "ASHRAFUL",
  "Rahman Md Mashiur",
  "Rahman Mizanur",
  "Rasel Mohammad",
  "Islam Mohammad Didarul",
  "RAMKUMAR",
  "THIRUMAL ASHOK",
  "SELVAKUMAR TAMILMANI",
  "PANDIYAN VETRIVEL",
  "SHIVKUMAR",
  "Zee Kwok Sheng",
  "Deng Yong",
  "ALFRED HO LUP MENG",
  "RAJU BHASKAR",
  "MURUGAN AYYAPPAN",
  "CHITAMBARAM RAMAN",
  "JAYARAMAN VENKATESAN",
  "TEO SIN FOOK",
  "VARATHARAJAN RAJADURAI",
  "Sakthivel Vignesh",
  "Balaraman Periyasamy",
  "Lim Kok soon Muhammad Rahim Lim",
  "RAHMAN MOKHLESUR",
  "YU JIN LIAN",
  "MAYANDI SARATHKUMAR",
  "JAMALUDIN BIN MOHD NOOR",
  "SUBRAMANIYAN SUNDARAMOORTHY",
  "RAJBONGSHI UMESH",
  "THANGAVELU KUMARESAN",
  "VELANGKANNI DASS",
  "TSZE HOK KOON",
  "WUJI SHENG",
  "MIAH KHOKON",
  "GUAN ENG LONG",
  "UDDIN KAMAL",
  "PUSHPARAJI PERIYASAMY",
  "RAMASAMY CHITRASENAN",
  "NAJUNDAPURAM KANNIAPPAN MUTHUKUMAR",
  "HOSSAIN MD SHAHADAT",
  "Milon",
  "Islam Ashraful",
  "Ali Showkat",
  "Miah khokan",
  "A Rahim",
  "BASKAR SELVAGANAPATHY",
  "MILTON PRADIP BHADRA",
  "KOU SHIH YANG",
  "JOSEPH RAJ ANTALIN VINS",
  "Malek Md Abdul",
  "Ang Kim Hock",
  "Song Wei Png",
  "Ding Haozhe",
  "Kong Hao Yi",
  "Varatharajan Mahendran",
  "Sekar karthikeyan",
  "SHEIKH MOHAMMAD SHOHAG",
];

// Map keyed by Novade project ID. Add new projects as we onboard them.
const ASSIGNEES_BY_PROJECT = {
  HVS: HVS_USERS,
};

function getKnownAssigneesForProject(projectId) {
  if (!projectId) return [];
  return ASSIGNEES_BY_PROJECT[projectId] || [];
}

module.exports = {
  ASSIGNEES_BY_PROJECT,
  getKnownAssigneesForProject,
};
