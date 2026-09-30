/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const logisticsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The sibling public Konjugate checkout; override with KONJUGATE_DIR.
export const konjugateDir = resolve(process.env.KONJUGATE_DIR ?? join(logisticsRoot, '..', 'konjugate'));

export function konjugateModule(relativePath) {
    return join(konjugateDir, relativePath);
}

// Default userData of a locally run Konjugate; override with KONJUGATE_USER_DATA.
export function defaultUserData() {
    if (process.env.KONJUGATE_USER_DATA) return resolve(process.env.KONJUGATE_USER_DATA);
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'konjugate');
    if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'konjugate');
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'konjugate');
}
