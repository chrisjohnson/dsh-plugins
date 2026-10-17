// Package entry. The profile patch row loads this module as the plugin's host
// half; `exports["./client"]` (package.json) points at the browser half.
//
// It is a one-line re-export on purpose: versioned `entry-rN.mjs` shims exist only
// to defeat Node's ES-module cache during development on a single deployment, and
// they must never be published.
export { default } from './src/host.mjs'
