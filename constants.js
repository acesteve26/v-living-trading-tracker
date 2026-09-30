// The single source of truth for the app's fixed vocabularies.
//
// These used to be repeated across the schema, the server, the forms, the
// dashboard and the report - adding one product category meant editing six
// places and hoping none were missed. Everything now reads from here, and the
// browser is sent the same lists via /api/settings so the dropdowns cannot
// drift from what the database will accept.

const PRODUCT_CATEGORIES = [
  'Tiles',
  'Sanitaryware',
  'Marble',
  'Wallpaper',
  'Furniture',
  'Mixed',
  'Other'
];

const STAGES = ['Lead', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'];

// Stages a deal is still being worked in - everything the pipeline figures count.
const OPEN_STAGES = ['Lead', 'Qualified', 'Proposal Sent', 'Negotiation'];

const ROLES = ['admin', 'management', 'accounts', 'sales'];

// What the business spends, as opposed to what a deal costs. Deal cost is
// already captured on the deal and drives gross profit; these are the overheads
// that sit alongside it, so the two are deliberately kept apart.
const EXPENSE_CATEGORIES = [
  'Rent',
  'Salaries',
  'Freight & Shipping',
  'Customs & Duty',
  'Marketing',
  'Utilities',
  'Travel',
  'Office',
  'Professional Fees',
  'Other'
];

// When a deal has no cost captured, gross profit is estimated at this margin
// so a month is never simply blank on the dashboard. Every figure that leans
// on it is marked with an asterisk, and the KPI tiles deliberately do not use
// it - those stay actual, counted only across deals with a real cost.
const ASSUMED_GP_MARGIN_PCT = 20;

// Management and accounts oversee and report; they do not work the pipeline.
const CAN_EDIT_DEALS = ['admin', 'sales'];
// Expenses are a bookkeeping record, so they belong to the finance roles
// rather than the sales ones. Everyone signed in can see them.
const CAN_EDIT_EXPENSES = ['admin', 'accounts'];
const CAN_MANAGE_USERS = ['admin'];
// Seeing what people have been doing is an oversight job, not an editing one,
// so management can read the activity log without being able to change anything.
const CAN_VIEW_ACTIVITY = ['admin', 'management'];

const DEFAULT_PROBABILITIES = {
  Lead: 10,
  Qualified: 30,
  'Proposal Sent': 50,
  Negotiation: 70,
  Won: 100,
  Lost: 0
};

const HISTORY_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'archived',
  'restored',
  'document_added',
  'document_removed'
];

// Everything worth recording that isn't a change to a deal. Deal changes stay
// in deal_history, which already holds them with their before and after; these
// are the things nothing was recording at all. The two are merged when read
// rather than written twice, so they cannot drift apart.
const ACTIVITY_ACTIONS = [
  'signed_in',
  'sign_in_failed',
  'signed_out',
  'password_changed',
  'user_created',
  'user_updated',
  'user_deactivated',
  'user_reactivated',
  'user_password_reset',
  'user_deleted',
  'report_run',
  'expense_created',
  'expense_updated',
  'expense_deleted'
];

// What can be attached to a deal. This is an allowlist by extension, and the
// content type sent back on download is taken from here rather than from
// whatever the browser claimed at upload time - a file that says it is a PDF
// and isn't should still be handed over as a PDF for saving, never interpreted.
// SVG and HTML are absent deliberately: both can carry script, and a document
// store is not a place to host pages.
const DOCUMENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip'
};

// What can be shown in the browser rather than only saved. Deliberately narrow:
// PDFs and ordinary images. Everything else - Word, Excel, ZIP - has no viewer
// here and would need the file handed to an outside service to render, which is
// not something customer paperwork should be doing.
const PREVIEWABLE_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
];

// 50 MB per deal, counted across everything attached to it. A business rule
// rather than a platform limit - Postgres would take far more - so it is set
// here and can be raised without touching anything else.
const MAX_DEAL_DOCUMENT_BYTES = 50 * 1024 * 1024;

// Renders a list as a SQL IN clause. Values here are developer-defined, never
// user input, but quotes are escaped anyway so a stray apostrophe in a future
// category cannot break the schema.
const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

module.exports = {
  PRODUCT_CATEGORIES,
  STAGES,
  OPEN_STAGES,
  ROLES,
  CAN_EDIT_DEALS,
  CAN_EDIT_EXPENSES,
  EXPENSE_CATEGORIES,
  CAN_MANAGE_USERS,
  CAN_VIEW_ACTIVITY,
  ACTIVITY_ACTIONS,
  DEFAULT_PROBABILITIES,
  ASSUMED_GP_MARGIN_PCT,
  HISTORY_ACTIONS,
  DOCUMENT_TYPES,
  PREVIEWABLE_TYPES,
  MAX_DEAL_DOCUMENT_BYTES,
  sqlList
};
