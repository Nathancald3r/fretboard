"""Sets how loud single drum-kit samples play in the built-in soundfont.

MuseScore General plays the ride about 30 dB under the kick and the closed hi-hat about
17 dB under it, so in a band mix they disappear. This rewrites the attenuation of those
zones in vendor/soundfont/MuseScore_General.sf3 in place (same file size, nothing else
touched). It sets absolute values, so running it twice changes nothing.

Run: python tools/drum_levels.py
"""
import struct
from pathlib import Path

SF = Path(__file__).resolve().parent.parent / 'vendor' / 'soundfont' / 'MuseScore_General.sf3'
# sample name -> attenuation in centibels (the soundfont's own values in brackets)
LEVELS = {
    'Ride1': 40,     # ride (150)
    'Ride2': 40,     # ride 2 (150)
    'BellRide': 60,  # ride bell (150)
    'Hi-Hat Closed': 100,  # (170)
    'Hi-Hat Foot': 120,    # pedal (170)
}
ATTEN = 48
SAMPLE = 53


def chunks(buf, off, end):
    while off < end:
        cid = buf[off:off + 4]
        size = struct.unpack_from('<I', buf, off + 4)[0]
        yield cid, off + 8, size
        off += 8 + size + (size & 1)


def main():
    data = bytearray(SF.read_bytes())
    where = {}
    for cid, o, sz in chunks(data, 12, len(data)):
        if cid == b'LIST' and data[o:o + 4] == b'pdta':
            for c2, o2, s2 in chunks(data, o + 4, o + sz):
                where[c2.decode()] = (o2, s2)
    ibag_o, ibag_s = where['ibag']
    igen_o, _ = where['igen']
    shdr_o, shdr_s = where['shdr']
    names = [data[shdr_o + i:shdr_o + i + 20].split(b'\0')[0].decode('latin-1') for i in range(0, shdr_s, 46)]
    bags = [struct.unpack_from('<HH', data, ibag_o + i)[0] for i in range(0, ibag_s, 4)]
    changed = 0
    for z in range(len(bags) - 1):
        gens = [(igen_o + 4 * g, *struct.unpack_from('<HH', data, igen_o + 4 * g)) for g in range(bags[z], bags[z + 1])]
        sample = next((amt for _, op, amt in gens if op == SAMPLE), None)
        if sample is None or names[sample] not in LEVELS:
            continue
        att = next((off for off, op, _ in gens if op == ATTEN), None)
        if att is None:
            raise SystemExit(f'zone {z} ({names[sample]}) has no attenuation of its own to change')
        struct.pack_into('<h', data, att + 2, LEVELS[names[sample]])
        changed += 1
    SF.write_bytes(bytes(data))
    print(f'set {changed} zones')


main()
