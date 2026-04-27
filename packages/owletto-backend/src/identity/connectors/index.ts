/**
 * Side-effect imports for every connector that should be available to the
 * identity engine. Each imported module self-registers via
 * `registerConnector(...)` at load time.
 *
 * Engine and auth-hook import this index for the side effects. Adding a
 * new connector: drop a file in this directory, end it with
 * `registerConnector(...)`, and add a side-effect import here. No core
 * code edit beyond this single line.
 */

import './google';
