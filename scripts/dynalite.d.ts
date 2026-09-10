// dynalite (the local testing tool that copies DynamoDB) doesn't come with
// TypeScript type definitions, so this just tells TypeScript "trust me,
// this module exists" so it doesn't complain about the import.
declare module 'dynalite';
