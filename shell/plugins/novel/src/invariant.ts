/**
 * Package-owned invariant companion for `@slacker/novel`.
 * @module @slacker/novel/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@slacker/novel'

/** Cordis companion plugin name. */
export const name = 'novel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the novel surface registers into a slot owned by the
 * slacker overlay and persists through the shell's kv commands — cross-plugin
 * state is the slot system's and the shell's, not this package's.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
