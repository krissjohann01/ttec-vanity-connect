/**
 * This has to be the very first thing scripts/local-server.ts imports.
 * Each Lambda handler sets up its AWS connection as soon as it's loaded, so
 * these settings need to already be in place before that happens.
 */
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'local';
process.env.AWS_SECRET_ACCESS_KEY = 'local';
process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';
process.env.TABLE_NAME = 'LocalCallLogTable';
