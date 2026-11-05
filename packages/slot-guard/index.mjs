// Package entry. The profile patch row loads this module as the plugin's host
// half; `exports["./client"]` (package.json) points at the browser half.
//
// The host half is deliberately almost empty: everything dsh-slot-guard does
// happens in the browser, where the crash it watches for happens. It exists so
// the bundle row composes and so a boot log line records that the diagnostics
// are installed.
export { default } from './src/host.mjs'
