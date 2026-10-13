// Install-line checks for package READMEs, kept apart from verify.mjs so they
// can be tested (scripts/test/install-lines.test.mjs).
//
// Releases are git tags, never npm. A README must show the git-tag spec for
// its own package and subdirectory, and must never show a bare-name install:
// that resolves from the npm registry, where an unscoped dsh-* name may belong
// to somebody else (the npm package `dsh-model-switch` does).

export const REPO_SPEC = 'git+https://github.com/chrisjohnson/dsh-plugins.git';

/** The spec prefix and path selector a README must show for one package. */
export function expectedSpec(name, dir) {
  return { spec: `${REPO_SPEC}#${name}-v`, pathPart: `&path:/packages/${dir}` };
}

/** Does some line run `dsh plugin … add` with this package's git-tag spec? */
export function hasTagInstall(readme, name, dir) {
  const { spec, pathPart } = expectedSpec(name, dir);
  return readme
    .split('\n')
    .some((line) => /\bdsh\s+plugin\b.*\badd\b/.test(line) && line.includes(spec) && line.includes(pathPart));
}

// A command at the start of a line (after an optional `$ ` prompt) that
// installs packages, followed by its arguments.
const INSTALL_COMMAND = /^\s*(?:\$\s+)?(?:pnpm\s+(?:add|install|i)|npm\s+(?:install|i|add)|yarn\s+add|dsh\s+plugin\b(?:\s+\S+)*?\s+add)\s+(.*)$/;

// A registry name: unscoped dsh-*, optionally with @version / @tag.
const BARE_NAME = /^dsh-[A-Za-z0-9._-]+(?:@\S+)?$/;

/**
 * The first line that installs a dsh-* package by bare name, or undefined.
 * Flags anywhere after the verb are skipped; quotes around a name are ignored.
 */
export function findBareInstall(readme) {
  for (const line of readme.split('\n')) {
    const match = INSTALL_COMMAND.exec(line);
    if (match === null) continue;
    const args = match[1].trim().split(/\s+/).map((arg) => arg.replace(/^["'`]|["'`]$/g, ''));
    if (args.some((arg) => !arg.startsWith('-') && BARE_NAME.test(arg))) return line;
  }
  return undefined;
}
