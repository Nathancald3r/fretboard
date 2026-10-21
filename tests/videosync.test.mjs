// Run: node tests/videosync.test.mjs
import assert from 'node:assert/strict';
import { bpmFromTaps, foldBpm, tempoCompare, guessTempoFromDurations, syncSummary, stashSync, restoreSync } from '../js/videosync.js';

const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

assert.equal(bpmFromTaps([0, 500]), null);
near(bpmFromTaps([0, 500, 1000, 1500, 2000]), 120);
near(bpmFromTaps([0, 500, 1000, 1180, 1500, 2000]), 120); // a stray tap barely matters
near(foldBpm(60, 120), 120);
near(foldBpm(240, 120), 120);
near(foldBpm(118, 120), 118);
near(foldBpm(80, 120), 120); // 2/3 -> 1.5x
near(foldBpm(45, 130), 45); // no fold lands near the tab: left alone

assert.equal(tempoCompare(120, 120).level, 'same');
assert.equal(tempoCompare(108, 120).pct, 90);
assert.equal(tempoCompare(108, 120).level, 'close');
assert.equal(tempoCompare(70, 120).level, 'far');
assert.equal(tempoCompare(0, 120), null);

assert.equal(guessTempoFromDurations({ tabSeconds: 200, videoSeconds: 0, tabBpm: 100 }), null);
const g = guessTempoFromDurations({ tabSeconds: 180, videoSeconds: 200, startSeconds: 20, tabBpm: 100 });
assert.equal(g.sure, true);
const slow = guessTempoFromDurations({ tabSeconds: 180, videoSeconds: 220, startSeconds: 10, tabBpm: 100 });
near(slow.bpm, 85.7, 0.1);
assert.equal(slow.sure, false);
assert.equal(guessTempoFromDurations({ tabSeconds: 180, videoSeconds: 600, tabBpm: 100 }).bpm, null);

assert.match(syncSummary({ startText: '0:12.0', bpm: 108, tabBpm: 120, offsetMs: -40, skips: 1 }), /Starts at 0:12.0 · video 108.0 BPM = 90% of the tab's speed \(slower\) · nudged -40 ms · 1 skip\./);
assert.match(syncSummary({}), /Start not set · tempo not matched/);

const song = { syncPoints: [[0, 500]], syncOffset: 20, videoMaster: 2, videoBpm: 99, skips: [[1, 2]] };
const map = stashSync(song, 'abc');
assert.deepEqual(restoreSync({ syncByVideo: map }, 'abc').syncPoints, [[0, 500]]);
assert.equal(restoreSync({ syncByVideo: map }, 'abc').videoBpm, 99);
assert.deepEqual(restoreSync({ syncByVideo: map }, 'zzz').syncPoints, []);
assert.deepEqual(stashSync({ syncByVideo: map }, null), map);
console.log('videosync ok');
