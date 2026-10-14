// Package entry. The bundle patch row loads this module as the plugin's host
// half; `exports["./client"]` (package.json) points at the browser half.
export { default } from './src/host.mjs'
