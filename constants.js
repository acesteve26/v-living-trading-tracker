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

const HISTORY_ACTIONS = ['created', 'updated', 'deleted', 'archived', 'restored'];

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
  sqlList
};
