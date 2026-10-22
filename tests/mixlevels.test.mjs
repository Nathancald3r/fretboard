// Run: node tests/mixlevels.test.mjs
import assert from 'node:assert/strict';
import { autoLevels, roleOf } from '../js/mixlevels.js';

const t = (name, program, extra = {}) => ({ name, program, volume: 13, drums: false, ...extra });

// A full band, all saved at the same file volume.
const band = [
  t('Singer', 54), t('Steel Guitar', 25), t('Overdriven Guitar', 29), t('Electric Bass', 33),
  t('Synthesizer', 89), t('Drumkit', 0, { drums: true }), t('Piano', 0), t('Backing Vocals', 52), t('Harmony', 54),
];
const v = autoLevels(band);
const [vox, rhythm, lead, bass, synth, drums, keys, bgv, harmony] = v;
assert.ok(vox > lead && vox > drums, 'vocals on top');
assert.ok(lead >= drums - 0.001 && lead > rhythm && lead > bass, 'lead guitar second');
assert.ok(drums > keys && bass > synth, 'drums and bass above pads');
assert.ok(bgv < vox && harmony < vox && bgv < lead, 'backing singers and harmonies sit back');
assert.ok(v.every((x) => x >= 0.25 && x <= 1.5));

// Unnamed second voice is a backing part; a "Lead Vocal" leads even if listed second.
assert.deepEqual(['Voice 1', 'Voice 2'].map((n, i) => roleOf(t(n, 54), 1, i === 0)), ['vocals', 'backing']);
assert.equal(roleOf(t('Lead Vocal', 54), 1, false), 'vocals');
assert.equal(roleOf(t('Lyrics', 54)), 'vocals');

// The only guitar is the lead; rhythm and lead named.
assert.equal(roleOf(t('Guitar', 25), 1), 'lead');
assert.equal(roleOf(t('Rhythm Guitar', 27), 2), 'rhythm');
assert.equal(roleOf(t('Lead Guitar', 27), 2), 'lead');
assert.equal(roleOf(t('Bass Guitar', 33), 2), 'bass');

// The file's own uneven volumes are evened out (a track saved quiet comes up).
const uneven = autoLevels([t('Lead Guitar', 29), t('Rhythm Guitar', 27, { volume: 6 }), t('Bass', 33)]);
assert.ok(uneven[1] > 1, `quiet track raised: ${uneven[1]}`);

console.log('mixlevels tests passed');
