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

// Management and accounts oversee and report; they do not work the pipeline.
const CAN_EDIT_DEALS = ['admin', 'sales'];
const CAN_MANAGE_USERS = ['admin'];

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
  CAN_MANAGE_USERS,
  DEFAULT_PROBABILITIES,
  HISTORY_ACTIONS,
  DOCUMENT_TYPES,
  MAX_DEAL_DOCUMENT_BYTES,
  sqlList
};
