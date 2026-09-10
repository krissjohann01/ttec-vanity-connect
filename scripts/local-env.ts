/**
 * Must be the first thing imported by scripts/local-server.ts -- every
 * handler module creates its AWS SDK client at module-load time, so these
 * env vars have to exist before anything else is required.
 */
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';
process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';
process.env.TABLE_NAME = 'LocalCallLogTable';
