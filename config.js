const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '.env');

// Node reads .env natively, so there's no dependency to install. In production
// (Render) there is no .env file — the platform supplies real environment
// variables instead, so a missing file is not an error.
try {
  process.loadEnvFile(envPath);
} catch (e) {
  /* no .env file — fall back to whatever the environment already provides */
}

const isProduction = process.env.NODE_ENV === 'production';

function fatal(message) {
  console.error(`\n  CONFIG ERROR: ${message}\n`);
  process.exit(1);
}

// The session secret signs login cookies. It must never be a value committed to
// git, or anyone reading the repo could forge a login.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  if (isProduction) {
    fatal(
      'SESSION_SECRET is not set.\n' +
        '  Set it in your hosting provider\'s environment variables before starting.\n' +
        '  Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // Local development: generate one and save it, so logins survive restarts.
  const generated = crypto.randomBytes(32).toString('hex');
  const header = fs.existsSync(envPath) ? '' : '# Local development settings - never commit this file\n';
  fs.appendFileSync(envPath, `${header}SESSION_SECRET=${generated}\n`);
  console.log('Generated a SESSION_SECRET for local development and saved it to .env');
  return generated;
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  fatal(
    'DATABASE_URL is not set.\n' +
      '  Locally: add it to .env (copy the External Database URL from your Render database).\n' +
      '  On Render: link the database to the service, which sets it automatically.'
  );
}

module.exports = {
  isProduction,
  port: process.env.PORT || 3000,
  sessionSecret: resolveSessionSecret(),
  // Render terminates HTTPS in front of the app, so cookies can be marked
  // secure there but must not be locally, or login breaks over plain http.
  secureCookies: isProduction,

  databaseUrl: resolveDatabaseUrl(),
  // Render's certificates verify cleanly against the public roots, so we keep
  // verification on rather than the rejectUnauthorized:false many guides suggest.
  // DB_SSL=off is an escape hatch for a local Postgres with no TLS.
  databaseSsl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: true }
};
