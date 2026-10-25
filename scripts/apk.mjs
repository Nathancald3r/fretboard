// The Android release in one go: node scripts/apk.mjs [--no-bump] [--no-install]
//   1. bumps versionCode by 1 and versionName by 0.01 in android/app/build.gradle (--no-bump keeps them)
//   2. builds the release APK (gradlew assembleRelease; the copyWeb task puts the web files in)
//   3. stops if the APK is 30 MB or more
//   4. keeps a copy as Fretboard-<version>.apk in the project folder (not committed)
//   5. installs it on the user's Pixel 8a over USB and checks the installed version (--no-install skips;
//      a phone that isn't plugged in only gives a warning, the build still counts)
import { readFileSync, writeFileSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gradleFile = join(root, 'android', 'app', 'build.gradle');
const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const adb = join(homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const PHONE = '49111JEKB02598';
const MAX_MB = 30;
const args = process.argv.slice(2);
const die = (msg) => { console.error(`STOP: ${msg}`); process.exit(1); };

let g = readFileSync(gradleFile, 'utf8');
let code = Number(g.match(/versionCode (\d+)/)[1]);
let name = g.match(/versionName '([^']+)'/)[1];
if (!args.includes('--no-bump')) {
  code += 1;
  name = (Number(name) + 0.01).toFixed(2);
  g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName '[^']+'/, `versionName '${name}'`);
  writeFileSync(gradleFile, g);
}
console.log(`Building Android ${name} (versionCode ${code})…`);

const win = process.platform === 'win32';
// gradlew.bat through cmd by its full path: the folder has spaces and [4] in it
const gradlew = join(root, 'android', win ? 'gradlew.bat' : 'gradlew');
const b = win
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${gradlew}" --console=plain assembleRelease -q"`],
    { cwd: join(root, 'android'), stdio: 'inherit', windowsVerbatimArguments: true })
  : spawnSync(gradlew, ['--console=plain', 'assembleRelease', '-q'], { cwd: join(root, 'android'), stdio: 'inherit' });
if (b.status !== 0) die('the build failed');

const mb = statSync(apk).size / 1e6;
if (mb >= MAX_MB) die(`the APK is ${mb.toFixed(1)} MB, over ${MAX_MB} MB`);
const keep = join(root, `Fretboard-${name}.apk`);
copyFileSync(apk, keep);
console.log(`APK ${mb.toFixed(1)} MB, kept as ${keep}`);

if (!args.includes('--no-install')) {
  if (!existsSync(adb)) die(`adb not found at ${adb}`);
  const devices = spawnSync(adb, ['devices'], { encoding: 'utf8' }).stdout;
  if (!new RegExp(`${PHONE}\\s+device`).test(devices)) {
    console.log('WARNING: the phone is not connected over USB (or not allowed), so it was not installed. Plug it in and run: node scripts/apk.mjs --no-bump');
  } else {
    const i = spawnSync(adb, ['-s', PHONE, 'install', '-r', apk], { encoding: 'utf8' });
    if (i.status !== 0) die(`install failed: ${(i.stdout + i.stderr).trim()}`);
    const v = spawnSync(adb, ['-s', PHONE, 'shell', 'dumpsys', 'package', 'app.fretboard'], { encoding: 'utf8' }).stdout;
    const got = (v.match(/versionName=(\S+)/) || [])[1];
    if (got !== name) die(`the phone reports ${got}, not ${name}`);
    console.log(`Installed ${name} on the phone.`);
  }
}
console.log(`APK_PATH=${apk}`);
