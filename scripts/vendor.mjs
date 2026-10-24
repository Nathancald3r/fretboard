// Copies alphaTab's browser build (script, fonts, soundfont) into vendor/ so the
// app can be served as plain static files (local server or GitHub Pages).
import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@coderline', 'alphatab', 'dist');
const dest = join(root, 'vendor', 'alphatab');

if (!existsSync(src)) {
  console.error('alphaTab not installed. Run "npm install" first.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
// Only what the browser build needs: the UMD script (also used for its worker and
// audio worklet), the Bravura music font and the default soundfont.
const keep = ['alphaTab.js', 'font/Bravura.woff2', 'font/Bravura.woff', 'font/Bravura.otf', 'font/Bravura-OFL.txt',
  'soundfont/sonivox.sf2', 'soundfont/LICENSE'];
for (const file of keep) cpSync(join(src, file), join(dest, file));
// alphaTab 1.8.4 bug: the worker player's loadedMidiInfo getter returns itself (endless
// recursion, thrown whenever something subscribes to midiLoaded). Point it at the field.
const script = join(dest, 'alphaTab.js');
// Second bug: two different marks on the same beat (a chord name and a swell "<") were put
// on one line, drawn over each other. A line is shared at a beat only by the same kind of mark.
const SLOT = 'if (this.shared.lastBeat === band.firstBeat) return true;';
const SLOT_FIX = 'if (this.shared.lastBeat === band.firstBeat && this.bands.every((b) => b.info.effectId === band.info.effectId)) return true;';
let code = readFileSync(script, 'utf8').replace('return this.loadedMidiInfo;', 'return this._loadedMidiInfo;');
if (!code.includes(SLOT)) throw new Error('alphaTab changed: effect line patch no longer applies');
code = code.replace(SLOT, SLOT_FIX);
// The TAB clef is drawn on the first line only, not at the start of every line.
const CLEF = '\t\t\t\tthis.createStartSpacing();\n\t\t\t\tthis.addPreBeatGlyph(new TabClefGlyph(0, this.getLineY(center)));\n';
if (!code.includes(CLEF)) throw new Error('alphaTab changed: TAB clef patch no longer applies');
code = code.replace(CLEF, '\t\t\t\tif (!this.bar.previousBar) {\n\t' + CLEF.replace('\n\t\t\t\tthis', '\n\t\t\t\t\tthis') + '\t\t\t\t}\n');
// Silence bug: a voice that produced one bad sample (NaN) kept it in its low-pass filter's
// memory, which alphaTab never cleared, so every later note on that voice was NaN and NaN in
// the mix silenced the whole song (When I Go Down went silent at the piano's first chord).
// A bad sample is dropped and the filter cleared, and a voice starts with a clean filter.
const LP = 'if (tmpLowpass.active) value = tmpLowpass.process(value);';
if (code.split(LP).length !== 4) throw new Error('alphaTab changed: low-pass guard patch no longer applies');
code = code.replaceAll(LP, 'if (value !== value) value = 0;\n\t\t\t\t\t\t\tif (tmpLowpass.active) { value = tmpLowpass.process(value); if (!Number.isFinite(value)) { value = 0; tmpLowpass.z1 = 0; tmpLowpass.z2 = 0; } }');
const LP_START = 'voice.lowPass.active = region.initialFilterFc <= 13500;';
if (!code.includes(LP_START)) throw new Error('alphaTab changed: low-pass reset patch no longer applies');
code = code.replace(LP_START, 'voice.lowPass.z1 = 0;\n\t\t\tvoice.lowPass.z2 = 0;\n\t\t\t' + LP_START);
// Stereo samples: alphaTab loads only mono ones and leaves a stereo instrument's left and right
// samples empty, so MuseScore General's grand piano (recorded in stereo) played nothing. Each
// half is loaded like a mono sample; the soundfont pans the two halves left and right.
const MONO = '} else if ((shdr.sampleType & 1) !== 0) {';
if (!code.includes(MONO)) throw new Error('alphaTab changed: stereo sample patch no longer applies');
code = code.replace(MONO, '} else if ((shdr.sampleType & 7) !== 0) {');
// Modulators: alphaTab ignores the soundfont's modulators. MuseScore General's grand piano
// opens its tone filter by note velocity through one, so without it the piano played through
// a filter closed near 80 Hz and was almost silent. The modulators that move the filter by
// velocity or key are applied when a note starts.
const MOD_HELPERS = `
	function fbModSource(src, key, vel) {
		const index = src & 127;
		let x = index === 2 ? vel / 127 : key / 127;
		if (src & 256) x = 1 - x;
		const type = src >> 10;
		const curve = (t) => type === 1 ? (t >= 1 ? 1 : t <= 0 ? 0 : -(40 / 96) * Math.log10(1 - t)) : type === 2 ? (t <= 0 ? 0 : t >= 1 ? 1 : 1 + (40 / 96) * Math.log10(t)) : type === 3 ? (t >= 0.5 ? 1 : 0) : t;
		if (src & 512) return x >= 0.5 ? curve(2 * x - 1) : -curve(1 - 2 * x);
		return curve(x);
	}
	function fbCollectMods(hydra, pFirst, pBag, iFirst, iBag) {
		const usable = (m) => {
			if (m.modDestOper !== 8 && m.modDestOper !== 11) return false;
			const okSource = (s) => !(s & 128) && ((s & 127) === 2 || (s & 127) === 3);
			return okSource(m.modSrcOper) && (m.modAmtSrcOper === 0 || okSource(m.modAmtSrcOper));
		};
		const same = (a, b) => a.modSrcOper === b.modSrcOper && a.modDestOper === b.modDestOper && a.modAmtSrcOper === b.modAmtSrcOper && a.modTransOper === b.modTransOper;
		const level = (mods, bags, gens, modField, genField, isZone, first, bag) => {
			const of = (b) => mods.slice(bags[b][modField], bags[b + 1][modField]);
			const local = of(bag);
			let global = [];
			if (first !== bag && !gens.slice(bags[first][genField], bags[first + 1][genField]).some((g) => g.genOper === isZone)) global = of(first).filter((g) => !local.some((l) => same(g, l)));
			return global.concat(local);
		};
		return level(hydra.imods, hydra.ibags, hydra.igens, 'instModNdx', 'instGenNdx', 53, iFirst, iBag)
			.concat(level(hydra.pmods, hydra.pbags, hydra.pgens, 'modNdx', 'genNdx', 41, pFirst, pBag))
			.filter(usable)
			.map((m) => ({ src: m.modSrcOper, dest: m.modDestOper, amount: (m.modAmount << 16) >> 16, amountSrc: m.modAmtSrcOper }));
	}
	function fbApplyMods(region, key, vel) {
		const r = new Region(region);
		for (const m of region.fbMods) {
			const v = fbModSource(m.src, key, vel) * (m.amountSrc ? fbModSource(m.amountSrc, key, vel) : 1) * m.amount;
			if (m.dest === 8) r.initialFilterFc += v;
			else r.modEnvToFilterFc += v;
		}
		return r;
	}
`;
const TSF = 'var TinySoundFont = class TinySoundFont {';
const LOOP = 'for (const region of this.presets[presetIndex].regions) {';
const SET_REGION = 'voice.region = region;';
const NEW_REGION = 'preset.regions[regionIndex] = new Region(zoneRegion);';
for (const s of [TSF, LOOP, SET_REGION, NEW_REGION]) if (code.split(s).length !== 2) throw new Error('alphaTab changed: modulator patch no longer applies (' + s + ')');
code = code.replace(TSF, MOD_HELPERS + '\t' + TSF);
code = code.replace(LOOP, 'for (let region of this.presets[presetIndex].regions) {');
code = code.replace(SET_REGION, 'if (region.fbMods && region.fbMods.length) region = fbApplyMods(region, key, midiVelocity);\n\t\t\t\t' + SET_REGION);
code = code.replace(NEW_REGION, NEW_REGION + '\n\t\t\t\t\t\t\t\t\t\tpreset.regions[regionIndex].fbMods = fbCollectMods(hydra, phdr.presetBagNdx, pbagIndex, inst.instBagNdx, ibagIndex);');
// Velocity layers: soundfonts made for FluidSynth (MuseScore General among them) expect the
// attenuation to be read at 0.4x. Read in full, the piano's mf layer sat 27 dB under its loudest.
// Only the part above an instrument's quietest-set layer is scaled, so single-layer instruments
// (the guitars) sound exactly as before.
const GAIN = 'voice.noteGainDb = this.globalGainDb - region.attenuation - SynthHelper.gainToDecibels(1 / vel);';
if (!code.includes(GAIN)) throw new Error('alphaTab changed: attenuation patch no longer applies');
// A floor for every instrument: a normal (mf) note at middle C is never set quieter than 20 dB,
// the quietest any guitar preset uses, so the guitars keep their level and nothing else (the
// piano was) is buried under them. Too-quiet instruments are lifted as a whole, keeping their
// soft-to-loud layers.
code = code.replace(GAIN, `const fbPreset = this.presets[presetIndex];
				if (fbPreset.fbMinAtt === undefined) {
					const min = fbPreset.regions.reduce((m, r) => Math.min(m, r.attenuation), Infinity);
					const typical = fbPreset.regions.filter((r) => r.loVel <= 95 && r.hiVel >= 95 && r.loKey <= 60 && r.hiKey >= 60).reduce((m, r) => Math.min(m, min + 0.4 * (r.attenuation - min)), Infinity);
					fbPreset.fbMinAtt = min;
					fbPreset.fbLift = Number.isFinite(typical) ? Math.max(0, typical - 20) : 0;
				}
				voice.noteGainDb = this.globalGainDb - (fbPreset.fbMinAtt + 0.4 * (region.attenuation - fbPreset.fbMinAtt) - fbPreset.fbLift) - SynthHelper.gainToDecibels(1 / vel);`);
// Steady playback when the page is busy or in a background tab: alphaTab passes every block of
// sound from the synth worker to the audio thread through the page's main thread, and keeps only
// about 0.2 s queued. A redraw, an import or a busy computer stalling the page for 0.1 s left a
// gap, and the song fell behind (0.25 s stalls lost 1.4 s in 4 s). The worker and the audio
// thread now talk directly over their own channel; the main thread only sets it up.
const fbPatch = (name, from, to) => {
  if (code.split(from).length !== 2) throw new Error('alphaTab changed: ' + name + ' patch no longer applies');
  code = code.replace(from, to);
};
fbPatch('direct channel (worklet in)', 'case "alphaSynth.output.addSamples":\n\t\t\t\t\t\t\tconst f = data.samples;',
  'case "fb.direct":\n\t\t\t\t\t\t\tthis._fbDirect = data.port;\n\t\t\t\t\t\t\tdata.port.onmessage = (m) => this._handleMessage(m);\n\t\t\t\t\t\t\tbreak;\n\t\t\t\t\t\tcase "alphaSynth.output.addSamples":\n\t\t\t\t\t\t\tconst f = data.samples;');
fbPatch('direct channel (worklet played)', 'this.port.postMessage({\n\t\t\t\t\t\tcmd: "alphaSynth.output.samplesPlayed",',
  '(this._fbDirect || this.port).postMessage({\n\t\t\t\t\t\tcmd: "alphaSynth.output.samplesPlayed",');
fbPatch('direct channel (worklet request)', 'for (let i = 0; i < halfBufferCount; i++) this.port.postMessage({ cmd: "alphaSynth.output.sampleRequest" });',
  'for (let i = 0; i < halfBufferCount; i++) (this._fbDirect || this.port).postMessage({ cmd: "alphaSynth.output.sampleRequest" });');
fbPatch('direct channel (main setup)', 'this._worklet.port.start();\n\t\t\t\tthis.source.connect(this._worklet);',
  'this._worklet.port.start();\n\t\t\t\tif (this.fbDirect) {\n\t\t\t\t\tconst ch = new MessageChannel();\n\t\t\t\t\tthis._worklet.port.postMessage({ cmd: "fb.direct", port: ch.port1 }, [ch.port1]);\n\t\t\t\t\tthis.fbDirect(ch.port2);\n\t\t\t\t}\n\t\t\t\tthis.source.connect(this._worklet);');
fbPatch('direct channel (main to worker)', 'this._synth = synthWorker;',
  'this._synth = synthWorker;\n\t\t\tthis._output.fbDirect = (port) => this._synth.postMessage({ cmd: "fb.direct", port }, [port]);');
fbPatch('direct channel (worker in)', 'switch (data.cmd) {\n\t\t\t\tcase "alphaSynth.output.sampleRequest":\n\t\t\t\t\tthis.sampleRequest.trigger();',
  'switch (data.cmd) {\n\t\t\t\tcase "fb.direct":\n\t\t\t\t\tthis._fbDirect?.close();\n\t\t\t\t\tthis._fbDirect = data.port;\n\t\t\t\t\tdata.port.onmessage = (m) => this._handleMessage(m);\n\t\t\t\t\tbreak;\n\t\t\t\tcase "alphaSynth.output.sampleRequest":\n\t\t\t\t\tthis.sampleRequest.trigger();');
fbPatch('direct channel (worker samples)', 'addSamples(samples) {\n\t\t\tthis._main.postMessage({\n\t\t\t\tcmd: "alphaSynth.output.addSamples",',
  'addSamples(samples) {\n\t\t\t(this._fbDirect || this._main).postMessage({\n\t\t\t\tcmd: "alphaSynth.output.addSamples",');
fbPatch('direct channel (worker reset)', 'resetSamples() {\n\t\t\tthis._main.postMessage({ cmd: "alphaSynth.output.resetSamples" });',
  'resetSamples() {\n\t\t\t(this._fbDirect || this._main).postMessage({ cmd: "alphaSynth.output.resetSamples" });');
fbPatch('direct channel (worker pause)', 'pause() {\n\t\t\tthis._main.postMessage({ cmd: "alphaSynth.output.pause" });',
  'pause() {\n\t\t\tthis._fbDirect?.close();\n\t\t\tthis._fbDirect = null;\n\t\t\tthis._main.postMessage({ cmd: "alphaSynth.output.pause" });');
// Drum sounds load only for the keys played on a drum channel, and alphaTab counted only channel 9.
// A second percussion track moved to its own channel with the drum kit bank (ownDrumChannels in
// js/humanize.js) had none of its sounds loaded and played nothing (When I Go Down's percussion).
// A channel given bank 128 (bank select 1) counts as a drum channel too.
fbPatch('drum bank keys (set)', 'let maxChannel = 0;\n\t\t\tlet previousTick = 0;',
  'let maxChannel = 0;\n\t\t\tconst fbDrumChannels = new Set([SynthConstants.PercussionChannel]);\n\t\t\tlet previousTick = 0;');
fbPatch('drum bank keys (bank)', '} else if (mEvent.type === MidiEventType.ProgramChange) {\n\t\t\t\t\tconst programChange = mEvent;',
  '} else if (mEvent.type === MidiEventType.ControlChange && mEvent.controller === ControllerType.BankSelectCoarse && mEvent.channel !== SynthConstants.PercussionChannel) {\n\t\t\t\t\tif (mEvent.value === 1) fbDrumChannels.add(mEvent.channel);\n\t\t\t\t\telse fbDrumChannels.delete(mEvent.channel);\n\t\t\t\t} else if (mEvent.type === MidiEventType.ProgramChange) {\n\t\t\t\t\tconst programChange = mEvent;');
fbPatch('drum bank keys (note)', 'if (noteOn.channel === SynthConstants.PercussionChannel) this.percussionKeys.add(noteOn.noteKey);',
  'if (fbDrumChannels.has(noteOn.channel)) this.percussionKeys.add(noteOn.noteKey);');
// MusicXML: Sibelius and others put <instrument id="P1-I1"/> on every note of a normal part.
// alphaTab took that id as a drum sound, so every pitched note became percussion and played
// key 0, 1 or 4: silence (I Will Sing of My Redeemer). Use the id only on a drum staff or an
// unpitched note.
fbPatch('musicxml pitched instrument', 'if (instrumentId !== null) note.percussionArticulation = trackInfo.getOrCreateArticulation(instrumentId, note);',
  'if (instrumentId !== null && (!isPitched || note.beat.voice.bar.staff.isPercussion)) note.percussionArticulation = trackInfo.getOrCreateArticulation(instrumentId, note);');
writeFileSync(script, code);
console.log('alphaTab copied to vendor/alphatab');
