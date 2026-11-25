/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The scratch Konjugate profile an interaction test launches with: the built packages installed, and the profile of
// someone who has taken Konjugate's first-model tour. On a profile that has never offered it, Konjugate's first launch
// starts the tour, which opens an empty "First model" in place of the project given on the command line; in Konjugate
// 2.0.2 it did so after that project had opened, so the test went on to build and run its network in the tour's empty model,
// with a global step of 0.01 s where the test's project says 0.05 days, and timed out after two minutes ten hours into
// a 120-day run. Konjugate's own suites avoid the tour with --interaction-test, which here would run Konjugate's suite.

import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateModule } from '../../scripts/konjugatePaths.mjs';

export async function prepareProfile(userData) {
    await installBuiltPackages(userData);
    const storePath = konjugateModule('src/welcomeStateStore.mjs');
    // A Konjugate from before the Welcome window keeps no such state and offers no tour.
    if (!await access(storePath).then(() => true, () => false)) return;
    const { createWelcomeStateStore, withTourCompleted } = await import(pathToFileURL(storePath));
    await createWelcomeStateStore({ directory: userData }).update(withTourCompleted);
}
