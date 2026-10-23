/**
 * Deterministic transcendental functions for every calculation path (stage 15.6).
 *
 * ECMAScript fixes +, −, ×, ÷ and sqrt to correctly rounded IEEE 754 results, but
 * not Math.sin/cos/tan/atan/atan2/acos/exp/log/hypot: engines may and do return
 * different last bits. Measured: Node 22 and Chromium 156 differed by 1 ulp in
 * Math.exp (injury-risk curves) and Math.sin/cos (collision normals), so the same
 * project produced different result hashes. These implementations are fdlibm
 * ports written in plain double arithmetic (stdlib, Apache-2.0, exact versions in
 * package.json), hence bit-identical in every conforming engine.
 * Rendering and editor code may keep Math.*: it never enters a saved result.
 */
import sin from '@stdlib/math-base-special-sin';
import cos from '@stdlib/math-base-special-cos';
import tan from '@stdlib/math-base-special-tan';
import atan from '@stdlib/math-base-special-atan';
import atan2 from '@stdlib/math-base-special-atan2';
import acos from '@stdlib/math-base-special-acos';
import exp from '@stdlib/math-base-special-exp';
import log from '@stdlib/math-base-special-ln';
import hypot from '@stdlib/math-base-special-hypot';

export const dm = { sin, cos, tan, atan, atan2, acos, exp, log, hypot } as const;
