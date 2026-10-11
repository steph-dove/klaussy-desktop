// Electron honours only one registerSchemesAsPrivileged call, so all privileged schemes register here, before app ready.

const { protocol } = require('electron');
const qaMedia = require('./qa-media-protocol');
const voice = require('./voice-protocol');

const SCHEMES = [qaMedia.PRIVILEGED, voice.PRIVILEGED];

protocol.registerSchemesAsPrivileged(SCHEMES);

module.exports = { SCHEMES };
