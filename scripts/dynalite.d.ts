// dynalite (a pure-JS local DynamoDB emulator, dev-tooling only) ships no
// type declarations -- this is a minimal ambient shim just so `tsc` and
// `ts-node` resolve the import cleanly.
declare module 'dynalite';
