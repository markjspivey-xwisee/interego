/**
 * A resolve hook for checks run with `node --experimental-strip-types`.
 *
 * The repository's TypeScript imports its neighbours with `.js` specifiers. Node's type
 * stripping loads `.ts` files but does not look for one when a `.js` specifier names a file
 * that is not there. This hook does exactly that and nothing else: a relative `.js` import
 * that fails to resolve is tried again as `.ts`.
 */
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier) && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    throw error;
  }
}
