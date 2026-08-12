/**
 * apps/ — OAuth application registry.
 *
 * Owns `oauth_apps`: registration, listing, and `client_secret` rotation.
 * The secret is stored hashed (SHA-256 over 32 bytes of CSPRNG output) and the
 * raw value is returned exactly once, at creation and at rotation.
 *
 * Public surface of this module. Nothing outside `platform/` imports the files
 * behind it — see platform/README.md for the boundary contract.
 */
export * from './types.js';
